import type { MigrationInterface } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from './migration-list.js';
import { assertMigrationsApplied, findPendingMigrations } from './pending-migrations.js';

class First1000 implements MigrationInterface {
  name = 'First1000';
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

class Second2000 implements MigrationInterface {
  name = 'Second2000';
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}

const MIGS = [First1000, Second2000];

const dataSourceWith = (executed: ReadonlyArray<string> | null) => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('to_regclass')) {
      return [{ present: executed !== null }];
    }
    return (executed ?? []).map((name) => ({ name }));
  }),
});

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

describe('Migraciones pendientes al arrancar', () => {
  it('lista las que faltan, en orden; sin tabla de control faltan todas (y no la crea)', async () => {
    expect(await findPendingMigrations(dataSourceWith(['First1000']) as never, MIGS)).toEqual(['Second2000']);
    const empty = dataSourceWith(null);
    expect(await findPendingMigrations(empty as never, MIGS)).toEqual(['First1000', 'Second2000']);
    expect(empty.query).toHaveBeenCalledTimes(1);
    expect(await findPendingMigrations(dataSourceWith(['First1000', 'Second2000']) as never, MIGS)).toEqual([]);
  });

  it('al día: no dice nada', async () => {
    const log = logger();
    await assertMigrationsApplied(dataSourceWith(['First1000', 'Second2000']) as never, { production: true, logger: log }, MIGS);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('fuera de producción avisa fuerte con los nombres y arranca', async () => {
    const log = logger();
    await assertMigrationsApplied(dataSourceWith(['First1000']) as never, { production: false, logger: log }, MIGS);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain('Faltan 1 migraciones: corra pnpm db:migrate');
    expect(log.warn.mock.calls[0]?.[0]).toContain('Second2000');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('en producción se niega a arrancar', async () => {
    const log = logger();
    await expect(
      assertMigrationsApplied(dataSourceWith([]) as never, { production: true, logger: log }, MIGS),
    ).rejects.toThrow('Faltan 2 migraciones: First1000, Second2000');
    expect(log.error.mock.calls[0]?.[0]).toContain('no arranca en producción');
  });

  it('la lista compartida coincide con lo que registra TypeORM (nombres únicos y en orden de timestamp)', () => {
    const names = MIGRATIONS.map((migration) => new migration().name ?? migration.name);
    expect(new Set(names).size).toBe(names.length);
    const stamps = names.map((name) => Number(/(\d{13})$/.exec(name ?? '')?.[1]));
    expect(stamps.every((stamp) => Number.isFinite(stamp))).toBe(true);
    expect([...stamps].sort((x, y) => x - y)).toEqual(stamps);
  });
});
