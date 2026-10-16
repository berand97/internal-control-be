import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { PgListener } from '../../../shared/events/pg-listener.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { FeatureFlag } from '../entities/feature-flag.entity.js';
import {
  FEATURE_CATALOG,
  findFeatureDefinition,
  isKnownFeatureCode,
  type FeatureDisabledReason,
  type FeatureSnapshot,
} from '../feature-catalog.js';

interface RuntimeOverride {
  readonly enabled: boolean;
  readonly reason: FeatureDisabledReason | null;
  readonly disabledAt: Date | null;
}

export const FEATURE_FLAGS_CHANNEL = 'feature_flags';
const RELOAD_ALL_PAYLOAD = '*';
export const PROBE_LEASE_MS = 30_000;

type CircuitPhase = 'OPEN' | 'HALF_OPEN';

const TRIP_SQL = `
  INSERT INTO feature_flag (code, enabled, disabled_reason, disabled_at, updated_at)
  VALUES ($1, false, 'CIRCUIT', $2, $2)
  ON CONFLICT (code) DO UPDATE
    SET enabled = false, disabled_reason = 'CIRCUIT', disabled_at = EXCLUDED.disabled_at, updated_at = EXCLUDED.updated_at
    WHERE feature_flag.enabled = true
  RETURNING code`;

@Injectable()
export class FeatureFlagsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly stored = new Map<string, RuntimeOverride>();
  private readonly failures = new Map<string, number[]>();
  private readonly probes = new Map<string, number>();
  private readonly tripping = new Set<string>();
  private writeSeq = 0;
  private reloadTimer: NodeJS.Timeout | null = null;
  private unlisten: (() => void) | null = null;
  private liveSync = false;

  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly listener: PgListener,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadAll();
  }

  async startLiveSync(): Promise<void> {
    if (this.liveSync) {
      return;
    }
    this.liveSync = true;
    this.unlisten = await this.listener.listen(FEATURE_FLAGS_CHANNEL, {
      notification: (payload) => {
        void this.onNotification(payload);
      },
      reconnected: () => {
        void this.safeReloadAll('reconexión LISTEN');
      },
    });
    const intervalMs = this.config.getOrThrow('features.reloadIntervalMs', { infer: true });
    if (intervalMs > 0) {
      this.reloadTimer = setInterval(() => {
        void this.safeReloadAll('relectura periódica');
      }, intervalMs);
      this.reloadTimer.unref();
    }
    this.logger.log(
      `Caché de módulos sincronizada con la BD (NOTIFY ${FEATURE_FLAGS_CHANNEL}` +
        (intervalMs > 0 ? `, relectura cada ${intervalMs / 1000} s)` : ', sin relectura periódica)'),
    );
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.unlisten?.();
    this.unlisten = null;
    this.liveSync = false;
  }

  async reloadAll(): Promise<void> {
    const seq = this.writeSeq;
    const rows = await this.flags.find();
    if (seq !== this.writeSeq) {
      return;
    }
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.code);
      this.apply(row.code, toOverride(row));
    }
    for (const code of this.stored.keys()) {
      if (!seen.has(code)) {
        this.apply(code, null);
      }
    }
  }

  async reloadOne(code: string): Promise<void> {
    const seq = this.writeSeq;
    const row = await this.flags.findOneBy({ code });
    if (seq !== this.writeSeq) {
      return;
    }
    this.apply(code, row ? toOverride(row) : null);
  }

  isEnabled(code: string): boolean {
    if (this.circuitPhase(code) === 'HALF_OPEN') {
      return false;
    }
    return this.snapshotFor(code).enabled;
  }

  admit(code: string): boolean {
    if (this.isEnabled(code)) {
      return true;
    }
    if (this.circuitPhase(code) !== 'HALF_OPEN') {
      return false;
    }
    const now = Date.now();
    const lease = this.probes.get(code);
    if (lease !== undefined && now - lease < PROBE_LEASE_MS) {
      return false;
    }
    this.probes.set(code, now);
    this.logger.warn(`Módulo ${code}: circuito medio abierto, se deja pasar una petición de prueba`);
    return true;
  }

  list(): ReadonlyArray<FeatureSnapshot> {
    return FEATURE_CATALOG.map((feature) => this.snapshotFor(feature.code));
  }

  async setEnabled(code: string, enabled: boolean): Promise<FeatureSnapshot> {
    const definition = findFeatureDefinition(code);
    if (!definition) {
      throw new ApiException(ErrorCode.FeatureUnknown);
    }
    if (definition.core) {
      throw new ApiException(ErrorCode.FeatureNotToggleable);
    }
    if (this.envOverride(code) !== undefined) {
      throw new ApiException(
        ErrorCode.FeatureNotToggleable,
        'Este módulo está fijado por variable de entorno',
      );
    }

    const reason: FeatureDisabledReason | null = enabled ? null : 'MANUAL';
    await this.persist(code, enabled, reason);
    this.failures.delete(code);
    this.probes.delete(code);
    this.logger.warn(
      enabled
        ? `Módulo ${code} reactivado manualmente`
        : `Módulo ${code} desactivado manualmente`,
    );
    return this.snapshotFor(code);
  }

  async recordSuccess(code: string): Promise<void> {
    if (!this.probes.has(code)) {
      return;
    }
    this.probes.delete(code);
    if (this.circuitPhase(code) !== 'HALF_OPEN') {
      return;
    }
    const disabledAt = this.stored.get(code)?.disabledAt ?? null;
    const now = new Date();
    try {
      const result = await this.write(() =>
        this.flags.update(
          { code, enabled: false, disabledReason: 'CIRCUIT' },
          { enabled: true, disabledReason: null, disabledAt: null, updatedAt: now },
        ),
      );
      if (!result.affected) {
        await this.reloadOne(code);
        return;
      }
    } catch (error) {
      this.logger.error(`Módulo ${code}: no se pudo guardar la reactivación automática: ${errorMessage(error)}`);
      return;
    }
    this.stored.set(code, { enabled: true, reason: null, disabledAt: null });
    this.failures.delete(code);
    const downtimeSeconds = disabledAt ? Math.round((now.getTime() - disabledAt.getTime()) / 1000) : null;
    this.logger.log(
      `Módulo ${code} reactivado automáticamente: la petición de prueba respondió bien` +
        (downtimeSeconds === null ? '' : ` (circuito abierto ${downtimeSeconds} s)`),
    );
    await this.audit(AuditAction.FeatureCircuitRecovered, code, { code, downtimeSeconds });
  }

  releaseProbe(code: string): void {
    this.probes.delete(code);
  }

  async recordFailure(code: string): Promise<void> {
    const definition = findFeatureDefinition(code);
    if (!definition || definition.core) {
      return;
    }
    if (this.envOverride(code) !== undefined) {
      return;
    }
    if (this.probes.has(code)) {
      this.probes.delete(code);
      await this.rearm(code);
      return;
    }
    if (!this.isEnabled(code)) {
      return;
    }

    const now = Date.now();
    const windowMs = this.config.getOrThrow('features.circuitWindowMs', { infer: true });
    const recent = (this.failures.get(code) ?? []).filter((at) => now - at < windowMs);
    recent.push(now);
    this.failures.set(code, recent);
    const threshold = this.config.getOrThrow('features.circuitThreshold', { infer: true });
    if (recent.length < threshold || this.tripping.has(code)) {
      return;
    }
    this.tripping.add(code);
    try {
      await this.trip(code, recent.length, windowMs);
    } finally {
      this.tripping.delete(code);
    }
  }

  private async trip(code: string, failures: number, windowMs: number): Promise<void> {
    const now = new Date();
    const cooldownMs = this.cooldownMs();
    this.failures.delete(code);
    try {
      const rows = (await this.write(() => this.flags.query(TRIP_SQL, [code, now]))) as unknown[];
      if (rows.length === 0) {
        await this.reloadOne(code);
        return;
      }
    } catch (error) {
      this.logger.error(`Módulo ${code}: no se pudo guardar la apertura del circuito: ${errorMessage(error)}`);
    }
    this.stored.set(code, { enabled: false, reason: 'CIRCUIT', disabledAt: now });
    this.logger.error(
      `Módulo ${code} desactivado por circuito: ${failures} errores internos en ${windowMs / 1000} s; ` +
        `se probará de nuevo desde ${new Date(now.getTime() + cooldownMs).toISOString()}`,
    );
    await this.audit(AuditAction.FeatureCircuitOpened, code, {
      code,
      failures,
      windowSeconds: windowMs / 1000,
      cooldownSeconds: cooldownMs / 1000,
    });
  }

  private async rearm(code: string): Promise<void> {
    if (this.circuitPhase(code) !== 'HALF_OPEN') {
      return;
    }
    const now = new Date();
    try {
      const result = await this.write(() =>
        this.flags.update({ code, enabled: false, disabledReason: 'CIRCUIT' }, { disabledAt: now, updatedAt: now }),
      );
      if (!result.affected) {
        await this.reloadOne(code);
        return;
      }
    } catch (error) {
      this.logger.error(`Módulo ${code}: no se pudo guardar el nuevo intervalo del circuito: ${errorMessage(error)}`);
    }
    this.stored.set(code, { enabled: false, reason: 'CIRCUIT', disabledAt: now });
    this.logger.error(
      `Módulo ${code} sigue fallando: la petición de prueba falló; ` +
        `nuevo intento desde ${new Date(now.getTime() + this.cooldownMs()).toISOString()}`,
    );
  }

  private circuitPhase(code: string, now = Date.now()): CircuitPhase | null {
    const definition = findFeatureDefinition(code);
    if (!definition || definition.core || this.envOverride(code) !== undefined) {
      return null;
    }
    const stored = this.stored.get(code);
    if (!stored || stored.enabled || stored.reason !== 'CIRCUIT') {
      return null;
    }
    return now < this.retryAtOf(stored) ? 'OPEN' : 'HALF_OPEN';
  }

  private retryAtOf(stored: RuntimeOverride): number {
    return (stored.disabledAt?.getTime() ?? 0) + this.cooldownMs();
  }

  private cooldownMs(): number {
    return this.config.getOrThrow('features.circuitCooldownMs', { infer: true });
  }

  private async audit(action: AuditAction, code: string, changes: Record<string, unknown>): Promise<void> {
    try {
      await this.auditLogs.record({
        action,
        entityType: 'FEATURE',
        entityId: featureAuditId(code),
        performedBy: null,
        ipAddress: null,
        userAgent: null,
        changes,
      });
    } catch (error) {
      this.logger.warn(`No se pudo auditar ${action} del módulo ${code}: ${errorMessage(error)}`);
    }
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    this.writeSeq += 1;
    try {
      return await operation();
    } finally {
      this.writeSeq += 1;
    }
  }

  private snapshotFor(code: string): FeatureSnapshot {
    const definition = findFeatureDefinition(code);
    if (!definition) {
      return {
        code,
        label: code,
        enabled: true,
        core: false,
        reason: null,
        retryAt: null,
        resourceTypes: [],
      };
    }

    const env = this.envOverride(code);
    if (definition.core) {
      return this.toSnapshot(definition, true, null);
    }
    if (env === false) {
      return this.toSnapshot(definition, false, 'ENV');
    }
    if (env === true) {
      return this.toSnapshot(definition, true, null);
    }

    const stored = this.stored.get(code);
    if (stored) {
      const phase = this.circuitPhase(code);
      if (phase === 'HALF_OPEN') {
        return this.toSnapshot(definition, true, null);
      }
      if (phase === 'OPEN') {
        return this.toSnapshot(definition, false, 'CIRCUIT', new Date(this.retryAtOf(stored)));
      }
      return this.toSnapshot(definition, stored.enabled, stored.reason);
    }
    const enabled = definition.defaultEnabled ?? true;
    return this.toSnapshot(definition, enabled, enabled ? null : 'DEFAULT');
  }

  private toSnapshot(
    definition: { code: string; label: string; core: boolean; resourceTypes: ReadonlyArray<string> },
    enabled: boolean,
    reason: FeatureDisabledReason | null,
    retryAt: Date | null = null,
  ): FeatureSnapshot {
    return {
      code: definition.code,
      label: definition.label,
      enabled,
      core: definition.core,
      reason: enabled ? null : reason,
      retryAt: enabled ? null : retryAt,
      resourceTypes: definition.resourceTypes,
    };
  }

  private async onNotification(payload: string | undefined): Promise<void> {
    try {
      if (!payload || payload === RELOAD_ALL_PAYLOAD) {
        await this.reloadAll();
      } else {
        await this.reloadOne(payload);
      }
    } catch (error) {
      this.logger.warn(`No se pudo releer el módulo tras NOTIFY: ${errorMessage(error)}`);
    }
  }

  private async safeReloadAll(origin: string): Promise<void> {
    try {
      await this.reloadAll();
    } catch (error) {
      this.logger.warn(`No se pudo releer los módulos (${origin}): ${errorMessage(error)}`);
    }
  }

  private apply(code: string, next: RuntimeOverride | null): void {
    const before = this.isEnabled(code);
    if (next) {
      this.stored.set(code, next);
    } else {
      this.stored.delete(code);
    }
    if (next?.reason !== 'CIRCUIT') {
      this.probes.delete(code);
    }
    const after = this.isEnabled(code);
    if (before !== after && isKnownFeatureCode(code)) {
      this.logger.warn(
        after
          ? `Módulo ${code} activo según la BD`
          : `Módulo ${code} inactivo según la BD (${this.stored.get(code)?.reason ?? 'sin motivo'})`,
      );
    }
  }

  private envOverride(code: string): boolean | undefined {
    return this.config.getOrThrow('features.overrides', { infer: true })[code];
  }

  private async persist(
    code: string,
    enabled: boolean,
    reason: FeatureDisabledReason | null,
  ): Promise<void> {
    const now = new Date();
    await this.write(() =>
      this.flags.save({
        code,
        enabled,
        disabledReason: enabled ? null : reason,
        disabledAt: enabled ? null : now,
        updatedAt: now,
      }),
    );
    this.stored.set(code, { enabled, reason: enabled ? null : reason, disabledAt: enabled ? null : now });
  }
}

const asDisabledReason = (value: string | null): FeatureDisabledReason | null => {
  if (value === 'MANUAL' || value === 'CIRCUIT' || value === 'ENV') {
    return value;
  }
  return null;
};

const toOverride = (row: FeatureFlag): RuntimeOverride => ({
  enabled: row.enabled,
  reason: row.enabled ? null : asDisabledReason(row.disabledReason),
  disabledAt: row.enabled ? null : row.disabledAt,
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'error');

export const featureAuditId = (code: string): string => {
  const bytes = createHash('sha1').update(`feature:${code}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
