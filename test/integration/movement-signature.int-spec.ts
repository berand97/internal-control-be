import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { MovementType } from '../../src/modules/assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../src/modules/assets/enums/operational-status.enum.js';
import { AssetStateService } from '../../src/modules/assets/services/asset-state.service.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { MovementsService } from '../../src/modules/movements/services/movements.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Firma y cadena de movimientos (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let state: AssetStateService;
  let movements: MovementsService;
  let actor: AuthenticatedUser;
  let base: { categoryId: string; costCenterId: string; acquisitionTypeId: string };

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    state = moduleRef.get(AssetStateService);
    movements = moduleRef.get(MovementsService);
    actor = await createActor(dataSource);
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo)
         VALUES ('IT_SIGN', 'Categoría firma', FALSE) RETURNING id`,
      ),
      costCenterId: await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name) VALUES ('IT-SIGN', 'Centro firma') RETURNING id`,
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

  const tampered = new Set<string>();

  const tamper = async (sql: string, params: unknown[]) => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query('SET session_replication_role = replica');
      await runner.query(sql, params);
      const [movementId] = params as string[];
      const [row] = (await runner.query(
        'SELECT asset_id FROM asset_movement WHERE id = $1 UNION SELECT asset_id FROM asset_movement WHERE previous_movement_id = $1',
        [movementId],
      )) as Array<{ asset_id: string }>;
      if (row) {
        tampered.add(row.asset_id);
      }
    } finally {
      await runner.query('SET session_replication_role = origin');
      await runner.release();
    }
  };

  const assetWithHistory = async () => {
    const asset = await assets.create(
      { ...base, description: `Firma ${randomUUID().slice(0, 6)}`, acquisitionDate: '2018-02-01' },
      actor,
    );
    await state.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: {},
      movement: {
        type: MovementType.PhysicalVerification,
        reason: 'Carga histórica',
        documentReference: 'EXCEL-2019',
        executedAt: new Date('2019-06-15T12:00:00.000Z'),
        metadata: { zeta: 1, alfa: 'orden', fila: 4317 },
      },
    });
    await assets.changeStatus(asset.id, OperationalStatus.InStorage, 'bodega', actor);
    const chain = (await dataSource.query(
      'SELECT id FROM asset_movement WHERE asset_id = $1 ORDER BY created_at',
      [asset.id],
    )) as Array<{ id: string }>;
    return { assetId: asset.id, ids: chain.map((row) => row.id) };
  };

  it('una cadena íntegra verifica sin fallos tras pasar por la base', async () => {
    const { assetId, ids } = await assetWithHistory();
    expect(ids).toHaveLength(3);
    expect(await movements.verifyAssetChain(assetId)).toEqual([]);
  });

  it('alterar la fecha de un movimiento histórico hace fallar la verificación', async () => {
    const { assetId, ids } = await assetWithHistory();
    await tamper(`UPDATE asset_movement SET executed_at = '2017-01-01T00:00:00Z' WHERE id = $1`, [ids[1]]);
    expect(await movements.verifyAssetChain(assetId)).toEqual([
      { assetId, movementId: ids[1], reason: 'SIGNATURE_MISMATCH' },
    ]);
    await expect(movements.verify(ids[1]!)).rejects.toMatchObject({ code: 'MOVEMENT_TAMPERED' });
  });

  it('alterar el motivo o el documento también se detecta', async () => {
    const { assetId, ids } = await assetWithHistory();
    await tamper(`UPDATE asset_movement SET reason = 'Otro motivo' WHERE id = $1`, [ids[1]]);
    await tamper(`UPDATE asset_movement SET document_reference = 'EXCEL-2020' WHERE id = $1`, [ids[2]]);
    const reasons = (await movements.verifyAssetChain(assetId)).map((failure) => failure.movementId);
    expect(reasons).toEqual([ids[1], ids[2]]);
  });

  it('borrar un eslabón intermedio rompe la cadena', async () => {
    const { assetId, ids } = await assetWithHistory();
    await tamper('DELETE FROM asset_movement WHERE id = $1', [ids[1]]);
    expect(await movements.verifyAssetChain(assetId)).toEqual(
      expect.arrayContaining([
        { assetId, movementId: ids[2], reason: 'BROKEN_LINK' },
        { assetId, movementId: null, reason: 'NOT_A_SINGLE_CHAIN' },
      ]),
    );
  });

  it('un movimiento firmado con el esquema anterior no se acepta', async () => {
    const { assetId, ids } = await assetWithHistory();
    await tamper(
      `UPDATE asset_movement SET metadata = metadata - 'signatureVersion' WHERE id = $1`,
      [ids[0]],
    );
    expect(await movements.verifyAssetChain(assetId)).toEqual([
      { assetId, movementId: ids[0], reason: 'LEGACY_SCHEME' },
    ]);
  });

  it('verifySample recorre cadenas completas y registra los fallos', async () => {
    const { assetId, ids } = await assetWithHistory();
    await tamper(`UPDATE asset_movement SET executed_at = '2016-01-01T00:00:00Z' WHERE id = $1`, [ids[1]]);
    const log = await movements.verifySample(10_000);
    expect(log.details).toEqual(
      expect.arrayContaining([{ assetId, movementId: ids[1], reason: 'SIGNATURE_MISMATCH' }]),
    );
    expect(log.assetsChecked).toBeGreaterThan(tampered.size);
    expect((log.details ?? []).filter((failure) => !tampered.has(failure.assetId))).toEqual([]);
  });
});
