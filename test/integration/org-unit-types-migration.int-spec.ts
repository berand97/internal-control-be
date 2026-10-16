import { DataSource, type QueryRunner } from 'typeorm';
import dataSourceConfig from '../../src/database/data-source.js';
import { OrgUnitTypesEstructuraOrganica1767226080000 } from '../../src/database/migrations/1767226080000-org-unit-types-estructura-organica.js';

/** Unidades con los tipos de antes de la Estructura Orgánica: [código, nombre, tipo]. */
const LEGACY: ReadonlyArray<readonly [string, string, string]> = [
  ['IT_MT_AREA', 'Área de Calidad', 'AREA'],
  ['IT_MT_OTHER', 'Institucional', 'OTHER'],
  ['IT_MT_COMITE', '  Comité de Inventarios', 'COUNCIL'],
  ['IT_MT_COMISION', 'COMISIÓN   Electoral', 'COUNCIL'],
  ['IT_MT_COMISION_2', 'comisión de personal', 'COUNCIL'],
  ['IT_MT_CONSEJO', 'Consejo Superior', 'COUNCIL'],
  ['IT_MT_COMITE_OF', 'Comité de Oficina', 'OFFICE'],
];

describe('Migración de tipos de unidad (Estructura Orgánica, Acuerdo 008/2021)', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  const migration = new OrgUnitTypesEstructuraOrganica1767226080000();

  const types = async (): Promise<Record<string, string>> => {
    const rows = (await runner.query(
      `SELECT code, unit_type FROM organizational_unit WHERE code LIKE 'IT\\_MT\\_%' ORDER BY code`,
    )) as Array<{ code: string; unit_type: string }>;
    return Object.fromEntries(rows.map((row) => [row.code, row.unit_type]));
  };

  const history = async (): Promise<Array<[string, string, string, string, string]>> => {
    const rows = (await runner.query(
      `SELECT u.code, h.old_value, h.new_value, h.source, h.reason
         FROM org_structure_history h JOIN organizational_unit u ON u.id = h.entity_id
        WHERE u.code LIKE 'IT\\_MT\\_%' AND h.field = 'TYPE' AND h.changed_by IS NULL
        ORDER BY h.changed_at, u.code, h.old_value`,
    )) as Array<{ code: string; old_value: string; new_value: string; source: string; reason: string }>;
    return rows.map((row) => [row.code, row.old_value, row.new_value, row.source, row.reason]);
  };

  beforeAll(async () => {
    dataSource = new DataSource({ ...dataSourceConfig.options, url: process.env['DATABASE_URL'] } as never);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    // Todo en una transacción que se deshace: up/down tocan todas las unidades de la base de pruebas.
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    for (const [code, name, type] of LEGACY) {
      await runner.query(
        `INSERT INTO organizational_unit (code, name, unit_type, hierarchy_level, hierarchy_path) VALUES ($1, $2, $3, 0, $4)`,
        [code, name, type, `/${code.toLowerCase()}`],
      );
    }
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('up: AREA y OTHER → DEPENDENCY; Consejos llamados Comité/Comisión → COMMITTEE/COMMISSION; cada cambio al historial', async () => {
    await migration.up(runner);
    expect(await types()).toEqual({
      IT_MT_AREA: 'DEPENDENCY',
      IT_MT_COMISION: 'COMMISSION',
      IT_MT_COMISION_2: 'COMMISSION',
      IT_MT_COMITE: 'COMMITTEE',
      IT_MT_COMITE_OF: 'OFFICE',
      IT_MT_CONSEJO: 'COUNCIL',
      IT_MT_OTHER: 'DEPENDENCY',
    });
    const reason = 'Tipos de la Estructura Orgánica (Acuerdo 008/2021, numeral 1.5)';
    expect(await history()).toEqual([
      ['IT_MT_AREA', 'AREA', 'DEPENDENCY', 'AUTO', reason],
      ['IT_MT_COMISION', 'COUNCIL', 'COMMISSION', 'AUTO', reason],
      ['IT_MT_COMISION_2', 'COUNCIL', 'COMMISSION', 'AUTO', reason],
      ['IT_MT_COMITE', 'COUNCIL', 'COMMITTEE', 'AUTO', reason],
      ['IT_MT_OTHER', 'OTHER', 'DEPENDENCY', 'AUTO', reason],
    ]);
    // Correr otra vez no cambia nada ni duplica el historial.
    await migration.up(runner);
    expect(await history()).toHaveLength(5);
  });

  it('down: DEPENDENCY → OTHER (AREA no se recupera), COMMITTEE/COMMISSION → COUNCIL; up de nuevo vuelve al estado nuevo', async () => {
    await migration.up(runner);
    await migration.down(runner);
    expect(await types()).toEqual({
      IT_MT_AREA: 'OTHER',
      IT_MT_COMISION: 'COUNCIL',
      IT_MT_COMISION_2: 'COUNCIL',
      IT_MT_COMITE: 'COUNCIL',
      IT_MT_COMITE_OF: 'OFFICE',
      IT_MT_CONSEJO: 'COUNCIL',
      IT_MT_OTHER: 'OTHER',
    });
    const reverted = (await history()).filter((row) => row[4] === 'Reversión de los tipos de la Estructura Orgánica');
    expect(reverted.map((row) => row.slice(0, 3))).toEqual([
      ['IT_MT_AREA', 'DEPENDENCY', 'OTHER'],
      ['IT_MT_COMISION', 'COMMISSION', 'COUNCIL'],
      ['IT_MT_COMISION_2', 'COMMISSION', 'COUNCIL'],
      ['IT_MT_COMITE', 'COMMITTEE', 'COUNCIL'],
      ['IT_MT_OTHER', 'DEPENDENCY', 'OTHER'],
    ]);
    await migration.up(runner);
    expect(await types()).toMatchObject({ IT_MT_AREA: 'DEPENDENCY', IT_MT_COMITE: 'COMMITTEE', IT_MT_COMISION: 'COMMISSION' });
  });
});
