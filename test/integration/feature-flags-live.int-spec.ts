import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { FeatureFlagsService } from '../../src/modules/features/services/feature-flags.service.js';
import { bootModules } from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (condition: () => boolean, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(20);
  }
  return condition();
};

/** La BD es la fuente de verdad de los módulos: dos "instancias" (dos contenedores Nest) y SQL a mano. */
describe('Módulos: caché viva por NOTIFY', () => {
  let a: TestingModule;
  let b: TestingModule;
  let dataSource: DataSource;
  let flagsA: FeatureFlagsService;
  let flagsB: FeatureFlagsService;

  beforeAll(async () => {
    a = await bootModules();
    b = await bootModules();
    dataSource = a.get(DataSource);
    flagsA = a.get(FeatureFlagsService);
    flagsB = b.get(FeatureFlagsService);
    await flagsA.startLiveSync();
    await flagsB.startLiveSync();
  });

  afterEach(async () => {
    await dataSource.query(`DELETE FROM feature_flag WHERE code IN ('campus', 'locations')`);
    await waitUntil(() => flagsA.isEnabled('campus') && flagsB.isEnabled('campus'));
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('el trigger notifica el código del módulo al cambiar la fila', async () => {
    const triggers = await dataSource.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'feature_flag'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers).toEqual([{ tgname: 'feature_flag_notify_row' }, { tgname: 'feature_flag_notify_truncate' }]);
  });

  it('un UPDATE por SQL se ve en todas las instancias sin reiniciar', async () => {
    expect(flagsA.isEnabled('campus')).toBe(true);
    await dataSource.query(
      `INSERT INTO feature_flag (code, enabled, disabled_reason, disabled_at, updated_at)
       VALUES ('campus', false, 'MANUAL', now(), now())`,
    );
    expect(await waitUntil(() => !flagsA.isEnabled('campus') && !flagsB.isEnabled('campus'))).toBe(true);
    expect(flagsB.list().find((item) => item.code === 'campus')?.reason).toBe('MANUAL');

    await dataSource.query(`UPDATE feature_flag SET enabled = true, disabled_reason = NULL, disabled_at = NULL WHERE code = 'campus'`);
    expect(await waitUntil(() => flagsA.isEnabled('campus') && flagsB.isEnabled('campus'))).toBe(true);
  });

  it('lo que cambia una instancia por la API lo ve la otra', async () => {
    await flagsA.setEnabled('locations', false);
    expect(flagsA.isEnabled('locations')).toBe(false);
    expect(await waitUntil(() => !flagsB.isEnabled('locations'))).toBe(true);
    await flagsB.setEnabled('locations', true);
    expect(await waitUntil(() => flagsA.isEnabled('locations'))).toBe(true);
  });

  it('un DELETE o TRUNCATE devuelve el módulo a su valor por defecto', async () => {
    await dataSource.query(
      `INSERT INTO feature_flag (code, enabled, disabled_reason, disabled_at, updated_at)
       VALUES ('campus', false, 'MANUAL', now(), now())`,
    );
    expect(await waitUntil(() => !flagsB.isEnabled('campus'))).toBe(true);
    const others = (await dataSource.query(`SELECT * FROM feature_flag WHERE code <> 'campus'`)) as Array<
      Record<string, unknown>
    >;
    await dataSource.transaction(async (manager) => {
      await manager.query('TRUNCATE feature_flag');
      for (const row of others) {
        await manager.query(
          `INSERT INTO feature_flag (code, enabled, disabled_reason, disabled_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
          [row['code'], row['enabled'], row['disabled_reason'], row['disabled_at'], row['updated_at']],
        );
      }
    });
    expect(await waitUntil(() => flagsA.isEnabled('campus') && flagsB.isEnabled('campus'))).toBe(true);
  });
});
