import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetIdentifier1767225624000 } from '../../src/database/migrations/1767225624000-asset-identifier.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Identificadores de activo (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: AssetsService;
  let actor: AuthenticatedUser;
  let categoryId: string;
  let costCenterId: string;
  let acquisitionTypeId: string;

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule);
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(AssetsService);
    actor = await createActor(dataSource);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo)
       VALUES ('IT_IDENT', 'Categoría identificadores', FALSE) RETURNING id`,
    );
    costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name)
       VALUES ('IT-IDENT', 'Centro identificadores') RETURNING id`,
    );
    acquisitionTypeId = await scalar<string>(
      dataSource,
      `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const identifiers = (assetId: string, runner: QueryRunner | DataSource = dataSource) =>
    runner.query(
      `SELECT identifier_type, value, origin, valid_to
       FROM asset_identifier WHERE asset_id = $1 ORDER BY identifier_type`,
      [assetId],
    ) as Promise<Array<{ identifier_type: string; value: string; origin: string; valid_to: Date | null }>>;

  const insertRaw = (runner: QueryRunner, internalCode: string, barcode: string | null) =>
    runner.query(
      `INSERT INTO asset (internal_code, barcode, description, category_id,
         acquisition_type_id, acquisition_date, current_cost_center_id, created_by)
       VALUES ($1, $2, 'Activo existente', $3, $4, '2020-01-01', $5, $6) RETURNING id`,
      [internalCode, barcode, categoryId, acquisitionTypeId, costCenterId, actor.id],
    ) as Promise<Array<{ id: string }>>;

  it('el alta escribe código visible, identificador opaco y código heredado', async () => {
    const asset = await service.create(
      {
        description: 'Con código heredado',
        categoryId,
        costCenterId,
        acquisitionTypeId,
        acquisitionDate: '2025-02-01',
        barcode: `BC-${randomUUID().slice(0, 8)}`,
      },
      actor,
    );
    const rows = await identifiers(asset.id);
    expect(rows.map((row) => row.identifier_type)).toEqual([
      'LEGACY_CODE',
      'OPAQUE_ID',
      'VISIBLE_CODE',
    ]);
    const visible = rows.find((row) => row.identifier_type === 'VISIBLE_CODE');
    const opaque = rows.find((row) => row.identifier_type === 'OPAQUE_ID');
    expect(visible?.value).toBe(asset.internalCode);
    expect(visible?.origin).toBe('GENERATED');
    expect(opaque?.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(opaque?.value).not.toContain(asset.internalCode);
  });

  it('acepta códigos heredados repetidos (TEMP) y rechaza visibles u opacos duplicados', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const [a] = await insertRaw(runner, `IT-${randomUUID().slice(0, 8)}`, null);
      const [b] = await insertRaw(runner, `IT-${randomUUID().slice(0, 8)}`, null);
      const add = (assetId: string, type: string, value: string, validTo: string | null = null) =>
        runner.query(
          `INSERT INTO asset_identifier (asset_id, identifier_type, value, origin, valid_from, valid_to)
           VALUES ($1, $2, $3, 'IMPORTED', '2020-01-01', $4)`,
          [assetId, type, value, validTo],
        );

      await add(a!.id, 'LEGACY_CODE', 'TEMP');
      await add(b!.id, 'LEGACY_CODE', 'TEMP');
      await add(a!.id, 'LEGACY_CODE', 'TEMP');

      await runner.query('SAVEPOINT visible');
      await add(a!.id, 'VISIBLE_CODE', 'V-001');
      await expect(add(b!.id, 'VISIBLE_CODE', 'V-001')).rejects.toThrow(
        /uq_asset_identifier_visible_current/,
      );
      await runner.query('ROLLBACK TO SAVEPOINT visible');

      await add(a!.id, 'VISIBLE_CODE', 'V-002', '2021-01-01');
      await add(b!.id, 'VISIBLE_CODE', 'V-002');

      await add(a!.id, 'OPAQUE_ID', 'op-1', '2021-01-01');
      await expect(add(b!.id, 'OPAQUE_ID', 'op-1')).rejects.toThrow(
        /uq_asset_identifier_opaque/,
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('el backfill de la migración conserva internal_code y barcode de activos existentes', async () => {
    const migration = new AssetIdentifier1767225624000();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query('DELETE FROM asset_identifier');
      await migration.down(runner);

      const [withBarcode] = await insertRaw(runner, 'A2019-0007', 'TEMP');
      const [withoutBarcode] = await insertRaw(runner, 'EXCEL-0045', null);

      await migration.up(runner);

      const first = await identifiers(withBarcode!.id, runner);
      expect(first).toEqual([
        expect.objectContaining({ identifier_type: 'LEGACY_CODE', value: 'TEMP', origin: 'IMPORTED' }),
        expect.objectContaining({ identifier_type: 'OPAQUE_ID', origin: 'GENERATED' }),
        expect.objectContaining({ identifier_type: 'VISIBLE_CODE', value: 'A2019-0007', origin: 'GENERATED' }),
      ]);
      const second = await identifiers(withoutBarcode!.id, runner);
      expect(second.map((row) => row.identifier_type)).toEqual(['OPAQUE_ID', 'VISIBLE_CODE']);
      expect(second.find((row) => row.identifier_type === 'VISIBLE_CODE')?.origin).toBe('IMPORTED');

      await runner.query(
        `UPDATE asset_identifier SET value = 'OTRO' WHERE asset_id = $1 AND identifier_type = 'LEGACY_CODE'`,
        [withBarcode!.id],
      );
      await expect(migration.down(runner)).rejects.toThrow(/revertir los perdería/);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
