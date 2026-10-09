import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { FeatureFlagsService } from './feature-flags.service.js';

interface Row {
  code: string;
  enabled: boolean;
  disabledReason: string | null;
  disabledAt: Date | null;
  updatedAt: Date;
}

/** Tabla feature_flag en memoria: save escribe, find/findOneBy leen (como la BD real). */
const createTable = () => {
  const rows = new Map<string, Row>();
  return {
    rows,
    find: vi.fn(async () => [...rows.values()].map((row) => ({ ...row }))),
    findOneBy: vi.fn(async ({ code }: { code: string }) => {
      const row = rows.get(code);
      return row ? { ...row } : null;
    }),
    save: vi.fn(async (row: Row) => {
      rows.set(row.code, { ...row });
      return row;
    }),
  };
};

type Handler = { notification(payload: string | undefined): void; reconnected(): void };

const createService = (
  overrides: Readonly<Record<string, boolean>> = {},
  threshold = 2,
  reloadIntervalMs = 30_000,
) => {
  const table = createTable();
  const handlers = new Map<string, Handler>();
  const unlisten = vi.fn();
  const listener = {
    listen: vi.fn(async (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
      return unlisten;
    }),
  };
  const config = {
    getOrThrow: vi.fn((key: string) => {
      if (key === 'features.circuitThreshold') {
        return threshold;
      }
      if (key === 'features.overrides') {
        return overrides;
      }
      if (key === 'features.reloadIntervalMs') {
        return reloadIntervalMs;
      }
      throw new Error(`unexpected key ${key}`);
    }),
  };
  const service = new FeatureFlagsService(table as never, config as never, listener as never);
  return { service, save: table.save, table, listener, handlers, unlisten };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
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

describe('FeatureFlagsService: caché viva de la BD', () => {
  it('al recibir NOTIFY de un código relee esa fila sin reiniciar', async () => {
    const { service, table, handlers, listener } = createService();
    await service.onModuleInit();
    await service.startLiveSync();
    expect(listener.listen).toHaveBeenCalledWith('feature_flags', expect.anything());
    expect(service.isEnabled('loans')).toBe(true);

    table.rows.set('loans', {
      code: 'loans',
      enabled: false,
      disabledReason: 'MANUAL',
      disabledAt: new Date(),
      updatedAt: new Date(),
    });
    handlers.get('feature_flags')?.notification('loans');
    await flush();
    expect(service.isEnabled('loans')).toBe(false);
    expect(table.findOneBy).toHaveBeenCalledWith({ code: 'loans' });

    // DELETE de la fila: vuelve al valor por defecto del catálogo.
    table.rows.delete('loans');
    handlers.get('feature_flags')?.notification('loans');
    await flush();
    expect(service.isEnabled('loans')).toBe(true);
    service.onModuleDestroy();
  });

  it("con '*' (TRUNCATE) o tras reconectar relee todo", async () => {
    const { service, table, handlers } = createService();
    await service.onModuleInit();
    await service.startLiveSync();
    table.rows.set('assets', {
      code: 'assets',
      enabled: false,
      disabledReason: 'MANUAL',
      disabledAt: new Date(),
      updatedAt: new Date(),
    });
    handlers.get('feature_flags')?.notification('*');
    await flush();
    expect(service.isEnabled('assets')).toBe(false);

    table.rows.clear();
    handlers.get('feature_flags')?.reconnected();
    await flush();
    expect(service.isEnabled('assets')).toBe(true);
    service.onModuleDestroy();
  });

  it('relee todo periódicamente como red de seguridad', async () => {
    vi.useFakeTimers();
    try {
      const { service, table } = createService({}, 2, 30_000);
      await service.onModuleInit();
      await service.startLiveSync();
      table.rows.set('campus', {
        code: 'campus',
        enabled: false,
        disabledReason: 'MANUAL',
        disabledAt: new Date(),
        updatedAt: new Date(),
      });
      expect(service.isEnabled('campus')).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.isEnabled('campus')).toBe(false);
      service.onModuleDestroy();
      table.rows.clear();
      await vi.advanceTimersByTimeAsync(60_000);
      // Detenido: la caché ya no cambia.
      expect(service.isEnabled('campus')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sin startLiveSync (CLI, pruebas) no escucha ni programa relecturas', async () => {
    vi.useFakeTimers();
    try {
      const { service, table, listener } = createService();
      await service.onModuleInit();
      expect(listener.listen).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(table.find).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('con FEATURE_FLAGS_RELOAD_SECONDS=0 solo escucha NOTIFY', async () => {
    vi.useFakeTimers();
    try {
      const { service, table, listener } = createService({}, 2, 0);
      await service.onModuleInit();
      await service.startLiveSync();
      expect(listener.listen).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(table.find).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('setEnabled actualiza la caché en el acto y una relectura vieja no la pisa', async () => {
    const { service, table } = createService();
    await service.onModuleInit();
    let release: (rows: Row[]) => void = () => undefined;
    table.find.mockImplementationOnce(
      () =>
        new Promise<Row[]>((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.reloadAll();
    await service.setEnabled('loans', false);
    expect(service.isEnabled('loans')).toBe(false);
    // La relectura empezó antes de la escritura y trae la tabla sin la fila.
    release([]);
    await pending;
    expect(service.isEnabled('loans')).toBe(false);
  });
});
