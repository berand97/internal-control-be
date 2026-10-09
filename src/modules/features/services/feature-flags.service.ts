import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { PgListener } from '../../../shared/events/pg-listener.js';
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

/** Canal de NOTIFY del trigger feature_flag_notify (migración FeatureFlagNotify1767226060000). */
export const FEATURE_FLAGS_CHANNEL = 'feature_flags';
/** Payload del trigger tras TRUNCATE: releer todo. */
const RELOAD_ALL_PAYLOAD = '*';

/**
 * Estado de los módulos. La BD (feature_flag) es la fuente de verdad; la memoria es una caché viva para que
 * `isEnabled` siga siendo síncrono (lo usan el guard en cada petición y los jobs):
 * - Al iniciar se carga todo.
 * - En el proceso HTTP (main.ts llama `startLiveSync`): LISTEN del canal `feature_flags` (un trigger avisa cada
 *   INSERT/UPDATE/DELETE, también los hechos a mano por SQL) y relectura completa periódica como red de seguridad
 *   (FEATURE_FLAGS_RELOAD_SECONDS). Si la conexión LISTEN se cae y vuelve, se relee todo.
 * - Los cambios hechos por este proceso (setEnabled, circuito) actualizan la caché en el acto.
 * CLI, exportador de OpenAPI y pruebas no llaman `startLiveSync`: no abren LISTEN ni temporizadores.
 */
@Injectable()
export class FeatureFlagsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly stored = new Map<string, RuntimeOverride>();
  private readonly consecutiveFailures = new Map<string, number>();
  /** Sube con cada escritura local: una relectura que empezó antes no pisa la caché con datos viejos. */
  private writeSeq = 0;
  private reloadTimer: NodeJS.Timeout | null = null;
  private unlisten: (() => void) | null = null;
  private liveSync = false;

  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly listener: PgListener,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadAll();
  }

  /**
   * Mantiene la caché al día con la BD: LISTEN `feature_flags` + relectura periódica. Solo el proceso HTTP la arranca
   * (main.ts); es idempotente.
   */
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

  /** Relee toda la tabla y reemplaza la caché (una fila borrada vuelve al valor por defecto del catálogo). */
  async reloadAll(): Promise<void> {
    const seq = this.writeSeq;
    const rows = await this.flags.find();
    if (seq !== this.writeSeq) {
      // Hubo una escritura local mientras se leía: su NOTIFY trae la fila al día.
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

  /** Relee una fila (NOTIFY del trigger). */
  async reloadOne(code: string): Promise<void> {
    const seq = this.writeSeq;
    const row = await this.flags.findOneBy({ code });
    if (seq !== this.writeSeq) {
      return;
    }
    this.apply(code, row ? toOverride(row) : null);
  }

  isEnabled(code: string): boolean {
    return this.snapshotFor(code).enabled;
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
    this.consecutiveFailures.set(code, 0);
    this.logger.warn(
      enabled
        ? `Módulo ${code} reactivado manualmente`
        : `Módulo ${code} desactivado manualmente`,
    );
    return this.snapshotFor(code);
  }

  recordSuccess(code: string): void {
    if (!isKnownFeatureCode(code) || findFeatureDefinition(code)?.core) {
      return;
    }
    this.consecutiveFailures.set(code, 0);
  }

  async recordFailure(code: string): Promise<void> {
    const definition = findFeatureDefinition(code);
    if (!definition || definition.core) {
      return;
    }
    if (!this.isEnabled(code)) {
      return;
    }
    if (this.envOverride(code) === true) {
      return;
    }

    const next = (this.consecutiveFailures.get(code) ?? 0) + 1;
    this.consecutiveFailures.set(code, next);
    const threshold = this.config.getOrThrow('features.circuitThreshold', {
      infer: true,
    });
    if (next < threshold) {
      return;
    }

    await this.persist(code, false, 'CIRCUIT');
    this.logger.error(
      `Módulo ${code} desactivado por circuito tras ${next} errores internos consecutivos`,
    );
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
      return this.toSnapshot(definition, stored.enabled, stored.reason);
    }
    const enabled = definition.defaultEnabled ?? true;
    return this.toSnapshot(definition, enabled, enabled ? null : 'DEFAULT');
  }

  private toSnapshot(
    definition: { code: string; label: string; core: boolean; resourceTypes: ReadonlyArray<string> },
    enabled: boolean,
    reason: FeatureDisabledReason | null,
  ): FeatureSnapshot {
    return {
      code: definition.code,
      label: definition.label,
      enabled,
      core: definition.core,
      reason: enabled ? null : reason,
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

  /** Pone en caché el estado leído de la BD y deja constancia si cambió lo que ve el usuario. */
  private apply(code: string, next: RuntimeOverride | null): void {
    const before = this.snapshotFor(code);
    if (next) {
      this.stored.set(code, next);
    } else {
      this.stored.delete(code);
    }
    const after = this.snapshotFor(code);
    if (before.enabled !== after.enabled && isKnownFeatureCode(code)) {
      this.logger.warn(
        after.enabled
          ? `Módulo ${code} activo según la BD`
          : `Módulo ${code} inactivo según la BD (${after.reason ?? 'sin motivo'})`,
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
    this.writeSeq += 1;
    await this.flags.save({
      code,
      enabled,
      disabledReason: enabled ? null : reason,
      disabledAt: enabled ? null : now,
      updatedAt: now,
    });
    this.writeSeq += 1;
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
