import { DataSource } from 'typeorm';
import dataSourceConfig from '../../src/database/data-source.js';
import { MIGRATIONS } from '../../src/database/migration-list.js';
import { assertMigrationsApplied, findPendingMigrations } from '../../src/database/pending-migrations.js';

describe('Revisión de migraciones pendientes contra PostgreSQL', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ ...dataSourceConfig.options, url: process.env['DATABASE_URL'] } as never);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('con la BD migrada no falta ninguna y producción arranca', async () => {
    expect(await findPendingMigrations(dataSource)).toEqual([]);
    const logger = { warn: vi.fn(), error: vi.fn() };
    await assertMigrationsApplied(dataSource, { production: true, logger });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('una migración del código que la BD no tiene aparece como pendiente', async () => {
    class NotYetApplied9999999999999 {
      name = 'NotYetApplied9999999999999';
      async up(): Promise<void> {}
      async down(): Promise<void> {}
    }
    expect(await findPendingMigrations(dataSource, [...MIGRATIONS, NotYetApplied9999999999999])).toEqual([
      'NotYetApplied9999999999999',
    ]);
  });
});
