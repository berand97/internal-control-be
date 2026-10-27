import { DataSource, type QueryRunner } from 'typeorm';
import dataSourceConfig from '../../src/database/data-source.js';
import { DependenciaLabels1767226090000 } from '../../src/database/migrations/1767226090000-dependencia-labels.js';

describe('Migración de textos a dependencia', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  const migration = new DependenciaLabels1767226090000();

  const descriptions = async (): Promise<Record<string, string>> => {
    const rows = (await runner.query(
      `SELECT code, description FROM permission
        WHERE code IN ('org_unit:read:global', 'org_unit:manage:global', 'asset:read:org_unit', 'asset:update:org_unit', 'loan:read:org_unit', 'loan:approve:org_unit')`,
    )) as Array<{ code: string; description: string }>;
    return Object.fromEntries(rows.map((row) => [row.code, row.description]));
  };

  const roleDescription = async (): Promise<string | undefined> => {
    const [row] = (await runner.query(`SELECT description FROM role WHERE code = 'DEPARTMENT_HEAD'`)) as Array<{
      description: string;
    }>;
    return row?.description;
  };

  const menuLabel = async (): Promise<string | undefined> => {
    const [row] = (await runner.query(`SELECT label FROM navigation_item WHERE path = '/organizational-units'`)) as Array<{
      label: string;
    }>;
    return row?.label;
  };

  beforeAll(async () => {
    dataSource = new DataSource({ ...dataSourceConfig.options, url: process.env['DATABASE_URL'] } as never);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('después de migrar, los textos sembrados dicen dependencia', async () => {
    const current = await descriptions();
    expect(Object.keys(current).length).toBeGreaterThan(0);
    for (const description of Object.values(current)) {
      expect(description).not.toMatch(/unidad/iu);
    }
    expect(current['org_unit:read:global']).toBe('Consultar dependencias');
    const role = await roleDescription();
    if (role !== undefined) {
      expect(role).toBe('Gestiona activos de su dependencia');
    }
  });

  it('down vuelve a los textos sembrados y up los cambia otra vez', async () => {
    await migration.down(runner);
    expect((await descriptions())['org_unit:read:global']).toBe('Consultar unidades organizacionales');
    await migration.up(runner);
    expect((await descriptions())['org_unit:read:global']).toBe('Consultar dependencias');
  });

  it('cambia el menú sembrado y respeta lo que un administrador editó', async () => {
    await runner.query(`UPDATE navigation_item SET label = 'Unidades organizacionales' WHERE path = '/organizational-units'`);
    await migration.up(runner);
    expect(await menuLabel()).toBe('Dependencias');

    await runner.query(`UPDATE navigation_item SET label = 'Mi organigrama' WHERE path = '/organizational-units'`);
    await runner.query(`UPDATE permission SET description = 'Texto del administrador' WHERE code = 'org_unit:read:global'`);
    await migration.down(runner);
    await migration.up(runner);
    expect(await menuLabel()).toBe('Mi organigrama');
    expect((await descriptions())['org_unit:read:global']).toBe('Texto del administrador');
  });
});
