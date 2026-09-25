import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { CategoriesModule } from '../../src/modules/categories/categories.module.js';
import { CategoriesService } from '../../src/modules/categories/services/categories.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Restricciones relajadas para datos reales (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let categories: CategoriesService;
  let actor: AuthenticatedUser;
  let categoryId: string;
  let costCenterId: string;
  let acquisitionTypeId: string;

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule, CategoriesModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    categories = moduleRef.get(CategoriesService);
    actor = await createActor(dataSource);
    costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name)
       VALUES ('IT-RELAX', 'Centro restricciones') RETURNING id`,
    );
    acquisitionTypeId = await scalar<string>(
      dataSource,
      `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
    );
    const category = await categories.create(
      { code: 'IT_RELAX', name: 'Categoría sin foto por defecto' },
      actor,
    );
    categoryId = category.id;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const insertRaw = (date: string | null, flags: string[]) =>
    dataSource.query(
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id,
         acquisition_date, current_cost_center_id, created_by, data_quality_flags)
       VALUES (left(gen_random_uuid()::text, 30), 'Carga', $1, $2, $3, $4, $5, $6)`,
      [categoryId, acquisitionTypeId, date, costCenterId, actor.id, flags],
    );

  it('una categoría nueva no exige foto y el activo se crea sin foto', async () => {
    expect(
      await scalar<boolean>(dataSource, 'SELECT requires_photo FROM asset_category WHERE id = $1', [
        categoryId,
      ]),
    ).toBe(false);
    const created = await assets.create(
      {
        description: 'Sin foto',
        categoryId,
        costCenterId,
        acquisitionTypeId,
        acquisitionDate: '2023-01-01',
      },
      actor,
    );
    expect(created.id).toBeDefined();
  });

  it('dos activos pueden compartir el código de barras (TEMP)', async () => {
    const base = { categoryId, costCenterId, acquisitionTypeId, acquisitionDate: '2023-01-01' };
    await assets.create({ ...base, description: 'Uno', barcode: 'TEMP' }, actor);
    await assets.create({ ...base, description: 'Dos', barcode: 'TEMP' }, actor);
    expect(
      Number(await scalar<string>(dataSource, `SELECT count(*) FROM asset WHERE barcode = 'TEMP' AND category_id = $1`, [categoryId])),
    ).toBe(2);
  });

  it('acepta fecha de adquisición vacía solo si la bandera lo declara', async () => {
    await expect(insertRaw(null, [])).rejects.toThrow(/chk_asset_acquisition_date_flagged/);
    await expect(insertRaw(null, ['ACQUISITION_DATE_MISSING'])).resolves.toBeDefined();
    await expect(insertRaw(null, ['ACQUISITION_DATE_INVALID', 'BARCODE_TEMP'])).resolves.toBeDefined();
  });

  it('rechaza banderas de calidad desconocidas', async () => {
    await expect(insertRaw('2020-01-01', ['INVENTADA'])).rejects.toThrow(
      /chk_asset_data_quality_flags/,
    );
  });
});
