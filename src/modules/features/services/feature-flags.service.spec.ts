import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { FeatureFlagsService } from './feature-flags.service.js';

const createService = (
  overrides: Readonly<Record<string, boolean>> = {},
  threshold = 2,
): {
  service: FeatureFlagsService;
  save: ReturnType<typeof vi.fn>;
} => {
  const save = vi.fn().mockResolvedValue(undefined);
  const flags = {
    find: vi.fn().mockResolvedValue([]),
    save,
  };
  const config = {
    getOrThrow: vi.fn((key: string) => {
      if (key === 'features.circuitThreshold') {
        return threshold;
      }
      if (key === 'features.overrides') {
        return overrides;
      }
      throw new Error(`unexpected key ${key}`);
    }),
  };
  const service = new FeatureFlagsService(flags as never, config as never);
  return { service, save };
};

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;
  let save: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const created = createService();
    service = created.service;
    save = created.save;
    await service.onModuleInit();
  });

  it('deja los módulos activos por defecto', () => {
    expect(service.isEnabled('loans')).toBe(true);
    expect(service.list().find((item) => item.code === 'loans')?.enabled).toBe(
      true,
    );
  });

  it('no permite apagar un módulo core', async () => {
    await expect(service.setEnabled('auth', false)).rejects.toMatchObject({
      code: ErrorCode.FeatureNotToggleable,
    });
  });

  it('apaga y reactiva un módulo de forma manual', async () => {
    const disabled = await service.setEnabled('loans', false);
    expect(disabled).toMatchObject({
      enabled: false,
      reason: 'MANUAL',
    });
    expect(service.isEnabled('loans')).toBe(false);
    const enabled = await service.setEnabled('loans', true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.reason).toBeNull();
  });

  it('respeta el kill-switch de entorno', async () => {
    const created = createService({ loans: false });
    await created.service.onModuleInit();
    expect(created.service.isEnabled('loans')).toBe(false);
    expect(created.service.list().find((item) => item.code === 'loans')).toMatchObject({
      enabled: false,
      reason: 'ENV',
    });
    await expect(created.service.setEnabled('loans', true)).rejects.toMatchObject({
      code: ErrorCode.FeatureNotToggleable,
    });
  });

  it('abre el circuito tras N fallos internos consecutivos', async () => {
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(true);
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(false);
    expect(service.list().find((item) => item.code === 'loans')?.reason).toBe(
      'CIRCUIT',
    );
    expect(save).toHaveBeenCalled();
  });

  it('un éxito reinicia el contador de fallos', async () => {
    await service.recordFailure('loans');
    service.recordSuccess('loans');
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(true);
  });
});
