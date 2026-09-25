import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { PhysicalCondition } from '../../src/modules/assets/enums/physical-condition.enum.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { InventoriesModule } from '../../src/modules/inventories/inventories.module.js';
import { InventoriesService } from '../../src/modules/inventories/services/inventories.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Toma física sobre el camino único de escritura (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let inventories: InventoriesService;
  let requester: AuthenticatedUser;
  let approver: AuthenticatedUser;
  let base: { categoryId: string; costCenterId: string; acquisitionTypeId: string };
  let roomA: string;
  let roomB: string;

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule, InventoriesModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    inventories = moduleRef.get(InventoriesService);
    requester = await createActor(dataSource);
    approver = await createActor(dataSource);
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo)
         VALUES ('IT_INV', 'Categoría toma', FALSE) RETURNING id`,
      ),
      costCenterId: await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name) VALUES ('IT-INV', 'Centro toma') RETURNING id`,
      ),
      acquisitionTypeId: await scalar<string>(
        dataSource,
        `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
      ),
    };
    const campus = await scalar<string>(
      dataSource,
      `INSERT INTO campus (code, name) VALUES ('IT-C', 'Sede prueba') RETURNING id`,
    );
    const building = await scalar<string>(
      dataSource,
      `INSERT INTO building (campus_id, code, name) VALUES ($1, 'IT-B', 'Bloque prueba') RETURNING id`,
      [campus],
    );
    const room = (code: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO location (building_id, code, name, location_type)
         VALUES ($1, $2, $2, 'OFFICE') RETURNING id`,
        [building, code],
      );
    roomA = await room('IT-101');
    roomB = await room('IT-102');
  });

  afterAll(async () => {
    await dataSource.query('DROP TRIGGER IF EXISTS it_fail_lost ON asset');
    await dataSource.query('DROP FUNCTION IF EXISTS it_fail_lost()');
    await moduleRef.close();
  });

  const newAsset = () =>
    assets.create(
      { ...base, description: `Toma ${randomUUID().slice(0, 6)}`, acquisitionDate: '2021-01-01', locationId: roomA },
      requester,
    );

  const newInventory = (status: string) =>
    scalar<string>(
      dataSource,
      `INSERT INTO physical_inventory (code, name, scheduled_start_date, scheduled_end_date, status,
         responsible_user_id, created_by, scope_type, scope_id, reconcile_requested_at, reconcile_requested_by)
       VALUES ($1, 'Toma de prueba', '2026-01-01', '2026-01-31', $2::text, $3, $3, 'COST_CENTER', $4,
         CASE WHEN $2::text = 'CLOSED' THEN NOW() END, CASE WHEN $2::text = 'CLOSED' THEN $3::uuid END)
       RETURNING id`,
      [`TF-IT-${randomUUID().slice(0, 6)}`, status, requester.id, base.costCenterId],
    );

  const addItem = (inventoryId: string, assetId: string, result: string, actualLocation: string | null) =>
    dataSource.query(
      `INSERT INTO physical_inventory_item (inventory_id, asset_id, verification_result,
         expected_location_id, actual_location_id, expected_condition, expected_cost_center_id)
       VALUES ($1, $2, $3, $4, $5, 'NEW', $6)`,
      [inventoryId, assetId, result, roomA, actualLocation, base.costCenterId],
    );

  const count = (sql: string, params: unknown[]) =>
    scalar<string>(dataSource, sql, params).then(Number);

  it('la verificación escribe ítem, fecha de verificación y movimiento juntos', async () => {
    const asset = await newAsset();
    const inventoryId = await newInventory('IN_PROGRESS');
    await addItem(inventoryId, asset.id, 'PENDING', null);

    await inventories.verifyAsset(
      inventoryId,
      { assetId: asset.id, locationId: roomB, condition: PhysicalCondition.Good },
      requester,
    );

    expect(
      await scalar<string>(
        dataSource,
        'SELECT verification_result FROM physical_inventory_item WHERE inventory_id = $1',
        [inventoryId],
      ),
    ).toBe('MISPLACED');
    expect(
      await scalar<Date | null>(dataSource, 'SELECT last_verified_at FROM asset WHERE id = $1', [asset.id]),
    ).not.toBeNull();
    const [movement] = (await dataSource.query(
      `SELECT movement_type, to_location_id, metadata FROM asset_movement
       WHERE asset_id = $1 AND movement_type = 'PHYSICAL_VERIFICATION'`,
      [asset.id],
    )) as Array<{ movement_type: string; to_location_id: string; metadata: Record<string, unknown> }>;
    expect(movement?.to_location_id).toBe(roomA);
    expect(movement?.metadata['observedLocationId']).toBe(roomB);
  });

  it('una conciliación que falla a la mitad no aplica ningún cambio', async () => {
    const misplaced = await newAsset();
    const missing = await newAsset();
    const inventoryId = await newInventory('CLOSED');
    await addItem(inventoryId, misplaced.id, 'MISPLACED', roomB);
    await addItem(inventoryId, missing.id, 'MISSING', null);

    await dataSource.query(`
      CREATE OR REPLACE FUNCTION it_fail_lost() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.id = '${missing.id}' AND NEW.operational_status = 'LOST' THEN
          RAISE EXCEPTION 'fallo simulado en el segundo activo';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await dataSource.query(
      'CREATE TRIGGER it_fail_lost BEFORE UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION it_fail_lost()',
    );
    const movementsBefore = await count(
      'SELECT count(*) FROM asset_movement WHERE asset_id = ANY($1)',
      [[misplaced.id, missing.id]],
    );

    await expect(inventories.approveReconcile(inventoryId, approver)).rejects.toThrow(
      /fallo simulado/,
    );

    expect(
      await scalar<string>(dataSource, 'SELECT current_location_id FROM asset WHERE id = $1', [misplaced.id]),
    ).toBe(roomA);
    expect(
      await scalar<string>(dataSource, 'SELECT status FROM physical_inventory WHERE id = $1', [inventoryId]),
    ).toBe('CLOSED');
    expect(
      await count('SELECT count(*) FROM asset_movement WHERE asset_id = ANY($1)', [
        [misplaced.id, missing.id],
      ]),
    ).toBe(movementsBefore);

    await dataSource.query('DROP TRIGGER it_fail_lost ON asset');
    await inventories.approveReconcile(inventoryId, approver);
    expect(
      await scalar<string>(dataSource, 'SELECT current_location_id FROM asset WHERE id = $1', [misplaced.id]),
    ).toBe(roomB);
    expect(
      await scalar<string>(dataSource, 'SELECT operational_status FROM asset WHERE id = $1', [missing.id]),
    ).toBe('LOST');
    expect(
      await scalar<string>(dataSource, 'SELECT status FROM physical_inventory WHERE id = $1', [inventoryId]),
    ).toBe('RECONCILED');
  });
});
