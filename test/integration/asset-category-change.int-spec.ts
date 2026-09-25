import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Cambio de categoría del activo (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let actor: AuthenticatedUser;
  let laptops: string;
  let monitors: string;
  let costCenterId: string;
  let acquisitionTypeId: string;

  const category = (code: string, parentId: string | null) =>
    scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, parent_id, requires_photo)
       VALUES ($1, $1, $2, FALSE) RETURNING id`,
      [code, parentId],
    );

  const field = (categoryId: string, code: string, type: string) =>
    dataSource.query(
      `INSERT INTO asset_category_field (category_id, field_code, field_label, field_type, is_required)
       VALUES ($1, $2, $2, $3, TRUE)`,
      [categoryId, code, type],
    );

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    actor = await createActor(dataSource);
    const equipment = await category('IT_EQUIPO', null);
    laptops = await category('IT_PORTATIL', equipment);
    monitors = await category('IT_MONITOR', equipment);
    await field(equipment, 'marca', 'STRING');
    await field(laptops, 'ramGB', 'NUMBER');
    await field(monitors, 'pulgadas', 'NUMBER');
    costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('IT-CAT', 'Centro categorías') RETURNING id`,
    );
    acquisitionTypeId = await scalar<string>(
      dataSource,
      `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const customValues = async (assetId: string) =>
    (
      (await dataSource.query(
        `SELECT f.field_code, v.value_text, v.value_number
         FROM asset_custom_value v JOIN asset_category_field f ON f.id = v.field_id
         WHERE v.asset_id = $1 ORDER BY f.field_code`,
        [assetId],
      )) as Array<{ field_code: string; value_text: string | null; value_number: string | null }>
    ).map((row) => [row.field_code, row.value_text ?? Number(row.value_number)]);

  it('guarda la categoría nueva, conserva lo heredado y exige los campos de la nueva', async () => {
    const asset = await assets.create(
      {
        description: 'Equipo que cambia de categoría',
        categoryId: laptops,
        costCenterId,
        acquisitionTypeId,
        acquisitionDate: '2024-01-01',
        customValues: { marca: 'HP', ramGB: 16 },
      },
      actor,
    );

    await expect(assets.update(asset.id, { categoryId: monitors }, actor)).rejects.toMatchObject({
      code: 'ASSET_MISSING_CUSTOM_FIELD',
    });
    expect(
      await scalar<string>(dataSource, 'SELECT category_id FROM asset WHERE id = $1', [asset.id]),
    ).toBe(laptops);

    const updated = await assets.update(
      asset.id,
      { categoryId: monitors, customValues: { pulgadas: 24 } },
      actor,
    );
    expect(updated.categoryId).toBe(monitors);
    expect(
      await scalar<string>(dataSource, 'SELECT category_id FROM asset WHERE id = $1', [asset.id]),
    ).toBe(monitors);
    expect(await customValues(asset.id)).toEqual([
      ['marca', 'HP'],
      ['pulgadas', 24],
    ]);
    const [audit] = (await dataSource.query(
      `SELECT changes FROM audit_log WHERE entity_id = $1 AND action = 'ASSET_UPDATED'
       ORDER BY performed_at DESC LIMIT 1`,
      [asset.id],
    )) as Array<{ changes: Record<string, unknown> }>;
    expect(audit?.changes['categoryId']).toBe(monitors);
  });
});
