import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
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
}

@Injectable()
export class FeatureFlagsService implements OnModuleInit {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly stored = new Map<string, RuntimeOverride>();
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.flags.find();
    for (const row of rows) {
      this.stored.set(row.code, {
        enabled: row.enabled,
        reason: asDisabledReason(row.disabledReason),
      });
    }
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
    return this.toSnapshot(definition, true, null);
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

  private envOverride(code: string): boolean | undefined {
    return this.config.getOrThrow('features.overrides', { infer: true })[code];
  }

  private async persist(
    code: string,
    enabled: boolean,
    reason: FeatureDisabledReason | null,
  ): Promise<void> {
    const now = new Date();
    await this.flags.save({
      code,
      enabled,
      disabledReason: enabled ? null : reason,
      disabledAt: enabled ? null : now,
      updatedAt: now,
    });
    this.stored.set(code, { enabled, reason: enabled ? null : reason });
  }
}

const asDisabledReason = (value: string | null): FeatureDisabledReason | null => {
  if (value === 'MANUAL' || value === 'CIRCUIT' || value === 'ENV') {
    return value;
  }
  return null;
};
