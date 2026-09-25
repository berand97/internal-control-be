import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AuditAction } from '../../src/modules/auth/enums/audit-action.enum.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { MovementType } from '../../src/modules/assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../src/modules/assets/enums/operational-status.enum.js';
import { AssetStateService } from '../../src/modules/assets/services/asset-state.service.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Camino único de escritura del activo (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let state: AssetStateService;
  let actor: AuthenticatedUser;
  let base: { categoryId: string; costCenterId: string; acquisitionTypeId: string };

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    state = moduleRef.get(AssetStateService);
    actor = await createActor(dataSource);
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo)
         VALUES ('IT_STATE', 'Categoría escritura', FALSE) RETURNING id`,
      ),
      costCenterId: await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name)
         VALUES ('IT-STATE', 'Centro escritura') RETURNING id`,
      ),
      acquisitionTypeId: await scalar<string>(
        dataSource,
        `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
      ),
    };
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const newAsset = () =>
    assets.create(
      { ...base, description: `Activo ${randomUUID().slice(0, 6)}`, acquisitionDate: '2022-03-01' },
      actor,
    );

  const snapshot = async (assetId: string) => ({
    location: await scalar<string | null>(
      dataSource,
      'SELECT current_location_id FROM asset WHERE id = $1',
      [assetId],
    ),
    responsible: await scalar<string | null>(
      dataSource,
      'SELECT current_responsible_id FROM asset WHERE id = $1',
      [assetId],
    ),
    movements: Number(
      await scalar<string>(dataSource, 'SELECT count(*) FROM asset_movement WHERE asset_id = $1', [
        assetId,
      ]),
    ),
    audits: Number(
      await scalar<string>(dataSource, 'SELECT count(*) FROM audit_log WHERE entity_id = $1', [
        assetId,
      ]),
    ),
  });

  const newPerson = () =>
    scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email)
       VALUES ('Responsable', 'Prueba', $1) RETURNING id`,
      [`resp.${randomUUID().slice(0, 8)}@unac.edu.co`],
    );

  it('un fallo a mitad de camino no deja ni el activo cambiado ni el movimiento', async () => {
    const asset = await newAsset();
    const person = await newPerson();
    const before = await snapshot(asset.id);

    await expect(
      state.apply({
        assetId: asset.id,
        actorId: actor.id,
        patch: { responsibleId: person },
        movement: { type: MovementType.Assignment, reason: 'prueba', documentReference: null },
        audit: { action: AuditAction.AssetUpdated },
        alsoWrite: async () => {
          throw new Error('fallo después de escribir activo y movimiento');
        },
      }),
    ).rejects.toThrow('fallo después de escribir activo y movimiento');

    expect(await snapshot(asset.id)).toEqual(before);
  });

  it('PATCH con un responsable inexistente no deja rastro parcial', async () => {
    const asset = await newAsset();
    const before = await snapshot(asset.id);
    await expect(
      assets.update(asset.id, { responsibleId: randomUUID() }, actor),
    ).rejects.toThrow();
    expect(await snapshot(asset.id)).toEqual(before);
  });

  it('PATCH de responsable y ubicación ahora registra el movimiento', async () => {
    const asset = await newAsset();
    const person = await newPerson();
    await assets.update(asset.id, { responsibleId: person }, actor);
    const [movement] = (await dataSource.query(
      `SELECT movement_type, from_responsible_id, to_responsible_id
       FROM asset_movement WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [asset.id],
    )) as Array<{ movement_type: string; from_responsible_id: string | null; to_responsible_id: string }>;
    expect(movement).toEqual({
      movement_type: 'ASSIGNMENT',
      from_responsible_id: null,
      to_responsible_id: person,
    });
  });

  it('acepta executedAt histórico y mantiene la cadena por orden de inserción', async () => {
    const asset = await newAsset();
    const historical = new Date('2019-06-15T12:00:00Z');
    await state.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: {},
      movement: {
        type: MovementType.PhysicalVerification,
        reason: 'Carga histórica',
        documentReference: 'EXCEL-2019',
        executedAt: historical,
      },
    });
    await assets.changeStatus(asset.id, OperationalStatus.InStorage, 'bodega', actor);

    const chain = (await dataSource.query(
      `SELECT id, movement_type, executed_at, previous_movement_id
       FROM asset_movement WHERE asset_id = $1 ORDER BY created_at`,
      [asset.id],
    )) as Array<{ id: string; movement_type: string; executed_at: Date; previous_movement_id: string | null }>;

    expect(chain.map((row) => row.movement_type)).toEqual([
      'REGISTRATION',
      'PHYSICAL_VERIFICATION',
      'CONDITION_CHANGE',
    ]);
    expect(chain[1]?.executed_at.toISOString()).toBe(historical.toISOString());
    expect(chain[0]?.previous_movement_id).toBeNull();
    expect(chain[1]?.previous_movement_id).toBe(chain[0]?.id);
    expect(chain[2]?.previous_movement_id).toBe(chain[1]?.id);
  });
});
