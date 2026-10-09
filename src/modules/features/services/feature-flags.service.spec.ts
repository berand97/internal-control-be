import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { featureAuditId, FeatureFlagsService, PROBE_LEASE_MS } from './feature-flags.service.js';

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
    update: vi.fn(async (where: Partial<Row> & { code: string }, patch: Partial<Row>) => {
      const row = rows.get(where.code);
      const matches =
        row !== undefined &&
        Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
      if (!matches) {
        return { affected: 0 };
      }
      rows.set(where.code, { ...row, ...patch });
      return { affected: 1 };
    }),
    /** Solo la apertura del circuito (TRIP_SQL): upsert que no pisa una fila ya apagada. */
    query: vi.fn(async (sql: string, [code, at]: [string, Date]) => {
      expect(sql).toContain('CIRCUIT');
      const row = rows.get(code);
      if (row && !row.enabled) {
        return [];
      }
      rows.set(code, { code, enabled: false, disabledReason: 'CIRCUIT', disabledAt: at, updatedAt: at });
      return [{ code }];
    }),
  };
};

type Handler = { notification(payload: string | undefined): void; reconnected(): void };

const WINDOW_MS = 120_000;
const COOLDOWN_MS = 300_000;

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
      if (key === 'features.circuitWindowMs') {
        return WINDOW_MS;
      }
      if (key === 'features.circuitCooldownMs') {
        return COOLDOWN_MS;
      }
      throw new Error(`unexpected key ${key}`);
    }),
  };
  const auditLogs = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new FeatureFlagsService(table as never, config as never, listener as never, auditLogs as never);
  return { service, save: table.save, table, listener, handlers, unlisten, auditLogs };
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

  it('abre el circuito tras N fallos internos dentro de la ventana', async () => {
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(true);
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(false);
    expect(service.list().find((item) => item.code === 'loans')?.reason).toBe(
      'CIRCUIT',
    );
  });
});

describe('FeatureFlagsService: circuito que se recupera solo', () => {
  const T0 = new Date('2026-10-08T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tripped = async (code = 'loans') => {
    const created = createService({}, 2);
    await created.service.onModuleInit();
    await created.service.recordFailure(code);
    await created.service.recordFailure(code);
    expect(created.service.isEnabled(code)).toBe(false);
    return created;
  };

  it('cuenta solo los fallos dentro de la ventana; los éxitos no borran la cuenta', async () => {
    const { service } = createService({}, 3);
    await service.onModuleInit();
    await service.recordFailure('loans');
    await service.recordFailure('loans');
    vi.advanceTimersByTime(WINDOW_MS + 1);
    // Los dos primeros salieron de la ventana.
    await service.recordFailure('loans');
    await service.recordSuccess('loans');
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(true);
    await service.recordFailure('loans');
    expect(service.isEnabled('loans')).toBe(false);
  });

  it('al abrir guarda disabled_at, audita sin datos personales e informa retryAt', async () => {
    const { service, table, auditLogs } = await tripped();
    expect(table.rows.get('loans')).toMatchObject({ enabled: false, disabledReason: 'CIRCUIT', disabledAt: T0 });
    const snapshot = service.list().find((item) => item.code === 'loans');
    expect(snapshot).toMatchObject({ enabled: false, reason: 'CIRCUIT' });
    expect(snapshot?.retryAt?.toISOString()).toBe(new Date(T0.getTime() + COOLDOWN_MS).toISOString());
    expect(auditLogs.record).toHaveBeenCalledTimes(1);
    expect(auditLogs.record).toHaveBeenCalledWith({
      action: 'FEATURE_CIRCUIT_OPEN',
      entityType: 'FEATURE',
      entityId: featureAuditId('loans'),
      performedBy: null,
      ipAddress: null,
      userAgent: null,
      changes: { code: 'loans', failures: 2, windowSeconds: 120, cooldownSeconds: 300 },
    });
    expect(featureAuditId('loans')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(featureAuditId('loans')).toBe(featureAuditId('loans'));
    expect(featureAuditId('loans')).not.toBe(featureAuditId('assets'));
  });

  it('durante la espera no deja pasar nada', async () => {
    const { service } = await tripped();
    vi.advanceTimersByTime(COOLDOWN_MS - 1);
    expect(service.admit('loans')).toBe(false);
    expect(service.list().find((item) => item.code === 'loans')?.enabled).toBe(false);
  });

  it('medio abierto: deja pasar UNA prueba; si responde bien reactiva el módulo y lo audita', async () => {
    const { service, table, auditLogs } = await tripped();
    vi.advanceTimersByTime(COOLDOWN_MS);
    // El menú lo vuelve a mostrar, pero los jobs esperan la confirmación.
    expect(service.list().find((item) => item.code === 'loans')).toMatchObject({
      enabled: true,
      reason: null,
      retryAt: null,
    });
    expect(service.isEnabled('loans')).toBe(false);
    expect(service.admit('loans')).toBe(true);
    expect(service.admit('loans')).toBe(false);

    await service.recordSuccess('loans');
    expect(service.isEnabled('loans')).toBe(true);
    expect(service.admit('loans')).toBe(true);
    expect(table.rows.get('loans')).toMatchObject({ enabled: true, disabledReason: null, disabledAt: null });
    expect(auditLogs.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'FEATURE_RECOVERED',
        performedBy: null,
        changes: { code: 'loans', downtimeSeconds: COOLDOWN_MS / 1000 },
      }),
    );
  });

  it('medio abierto: si la prueba falla sigue apagado y la espera vuelve a empezar', async () => {
    const { service, table, auditLogs } = await tripped();
    vi.advanceTimersByTime(COOLDOWN_MS + 5_000);
    expect(service.admit('loans')).toBe(true);
    await service.recordFailure('loans');
    const rearmedAt = new Date(T0.getTime() + COOLDOWN_MS + 5_000);
    expect(table.rows.get('loans')).toMatchObject({ enabled: false, disabledReason: 'CIRCUIT', disabledAt: rearmedAt });
    expect(service.admit('loans')).toBe(false);
    expect(service.list().find((item) => item.code === 'loans')?.retryAt?.toISOString()).toBe(
      new Date(rearmedAt.getTime() + COOLDOWN_MS).toISOString(),
    );
    // Solo la apertura se audita, no cada prueba fallida.
    expect(auditLogs.record).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(COOLDOWN_MS);
    expect(service.admit('loans')).toBe(true);
  });

  it('una prueba que termina en 4xx libera el turno sin decidir; un turno abandonado vence', async () => {
    const { service } = await tripped();
    vi.advanceTimersByTime(COOLDOWN_MS);
    expect(service.admit('loans')).toBe(true);
    service.releaseProbe('loans');
    expect(service.isEnabled('loans')).toBe(false);
    expect(service.admit('loans')).toBe(true);
    expect(service.admit('loans')).toBe(false);
    vi.advanceTimersByTime(PROBE_LEASE_MS);
    expect(service.admit('loans')).toBe(true);
  });

  it('el circuito sobrevive reinicios: la espera sale de disabled_at en la BD', async () => {
    const { table } = await tripped();
    const restarted = createService({}, 2);
    for (const [code, row] of table.rows) {
      restarted.table.rows.set(code, { ...row });
    }
    await restarted.service.onModuleInit();
    expect(restarted.service.admit('loans')).toBe(false);
    vi.advanceTimersByTime(COOLDOWN_MS);
    expect(restarted.service.admit('loans')).toBe(true);
  });

  it('MANUAL nunca se reactiva solo', async () => {
    const { service, table } = createService({}, 2);
    await service.onModuleInit();
    await service.setEnabled('loans', false);
    vi.advanceTimersByTime(COOLDOWN_MS * 10);
    expect(service.admit('loans')).toBe(false);
    await service.recordSuccess('loans');
    expect(service.isEnabled('loans')).toBe(false);
    expect(table.rows.get('loans')?.disabledReason).toBe('MANUAL');
    expect(service.list().find((item) => item.code === 'loans')).toMatchObject({ enabled: false, retryAt: null });
  });

  it('ENV nunca se reactiva solo ni lo abre el circuito', async () => {
    const { service, table } = createService({ loans: false, assets: true }, 2);
    // Aunque la BD diga CIRCUIT vencido, manda el entorno.
    table.rows.set('loans', {
      code: 'loans',
      enabled: false,
      disabledReason: 'CIRCUIT',
      disabledAt: new Date(T0.getTime() - COOLDOWN_MS * 2),
      updatedAt: T0,
    });
    await service.onModuleInit();
    expect(service.admit('loans')).toBe(false);
    expect(service.list().find((item) => item.code === 'loans')).toMatchObject({ reason: 'ENV', retryAt: null });
    await service.recordFailure('assets');
    await service.recordFailure('assets');
    expect(service.isEnabled('assets')).toBe(true);
    expect(table.query).not.toHaveBeenCalled();
  });

  it('si otra instancia ya lo apagó, no lo pisa ni audita', async () => {
    const { service, table, auditLogs } = createService({}, 2);
    await service.onModuleInit();
    table.rows.set('loans', {
      code: 'loans',
      enabled: false,
      disabledReason: 'MANUAL',
      disabledAt: T0,
      updatedAt: T0,
    });
    await service.recordFailure('loans');
    await service.recordFailure('loans');
    expect(table.rows.get('loans')?.disabledReason).toBe('MANUAL');
    expect(service.list().find((item) => item.code === 'loans')?.reason).toBe('MANUAL');
    expect(auditLogs.record).not.toHaveBeenCalled();
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
