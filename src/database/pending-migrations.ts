import type { DataSource, MigrationInterface } from 'typeorm';
import { MIGRATIONS } from './migration-list.js';

type MigrationClass = new () => MigrationInterface;

const MIGRATIONS_TABLE = 'migrations';

export interface PendingMigrationsLogger {
  warn(message: string): void;
  error(message: string): void;
}

const migrationName = (migration: MigrationClass): string => new migration().name ?? migration.name;

export const findPendingMigrations = async (
  dataSource: DataSource,
  migrations: ReadonlyArray<MigrationClass> = MIGRATIONS,
): Promise<ReadonlyArray<string>> => {
  const [table] = (await dataSource.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [MIGRATIONS_TABLE])) as Array<{
    present: boolean;
  }>;
  const executed = new Set<string>();
  if (table?.present) {
    const rows = (await dataSource.query(`SELECT name FROM ${MIGRATIONS_TABLE}`)) as Array<{ name: string }>;
    for (const row of rows) {
      executed.add(row.name);
    }
  }
  return migrations.map(migrationName).filter((name) => !executed.has(name));
};

export const assertMigrationsApplied = async (
  dataSource: DataSource,
  options: { readonly production: boolean; readonly logger: PendingMigrationsLogger },
  migrations: ReadonlyArray<MigrationClass> = MIGRATIONS,
): Promise<void> => {
  const pending = await findPendingMigrations(dataSource, migrations);
  if (pending.length === 0) {
    return;
  }
  const list = pending.map((name) => `  - ${name}`).join('\n');
  if (options.production) {
    const message =
      `Faltan ${pending.length} migraciones en la base de datos; el backend no arranca en producción así:\n${list}\n` +
      'Aplíquelas (RUN_MIGRATIONS=true en el contenedor o `typeorm migration:run`) y vuelva a iniciar.';
    options.logger.error(message);
    throw new Error(`Faltan ${pending.length} migraciones: ${pending.join(', ')}`);
  }
  options.logger.warn(
    `Faltan ${pending.length} migraciones: corra pnpm db:migrate\n${list}\n` +
      'Mientras tanto los módulos que usen tablas o columnas nuevas fallarán.',
  );
};
