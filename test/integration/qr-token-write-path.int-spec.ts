import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { QrTokensModule } from '../../src/modules/qr-tokens/qr-tokens.module.js';
import { QrTokensService } from '../../src/modules/qr-tokens/services/qr-tokens.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('QR sobre el camino único de escritura (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let qr: QrTokensService;
  let actor: AuthenticatedUser;
  let base: { categoryId: string; costCenterId: string; acquisitionTypeId: string };

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule, QrTokensModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    qr = moduleRef.get(QrTokensService);
    actor = await createActor(dataSource);
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo)
         VALUES ('IT_QR', 'Categoría QR', FALSE) RETURNING id`,
      ),
      costCenterId: await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name) VALUES ('IT-QR', 'Centro QR') RETURNING id`,
      ),
      acquisitionTypeId: await scalar<string>(
        dataSource,
        `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
      ),
    };
  });

  afterAll(async () => {
    await dataSource.query('DROP TRIGGER IF EXISTS it_fail_rotation ON qr_token_rotation_log');
    await dataSource.query('DROP FUNCTION IF EXISTS it_fail_rotation()');
    await moduleRef.close();
  });

  const state = async (assetId: string) => ({
    token: await scalar<string | null>(dataSource, 'SELECT qr_token FROM asset WHERE id = $1', [assetId]),
    rotations: Number(
      await scalar<string>(dataSource, 'SELECT count(*) FROM qr_token_rotation_log WHERE asset_id = $1', [assetId]),
    ),
    movements: Number(
      await scalar<string>(
        dataSource,
        `SELECT count(*) FROM asset_movement WHERE asset_id = $1 AND movement_type = 'QR_ROTATION'`,
        [assetId],
      ),
    ),
    audits: Number(
      await scalar<string>(
        dataSource,
        `SELECT count(*) FROM audit_log WHERE entity_id = $1 AND action IN ('QR_ISSUED', 'QR_REVOKED')`,
        [assetId],
      ),
    ),
  });

  it('emitir y revocar escriben activo, log de rotación, movimiento y auditoría juntos', async () => {
    const asset = await assets.create(
      { ...base, description: 'Con QR', acquisitionDate: '2024-01-01' },
      actor,
    );
    await qr.issue(asset.id, actor, false, 256);
    const issued = await state(asset.id);
    expect(issued.token).not.toBeNull();
    expect(issued).toMatchObject({ rotations: 1, movements: 1, audits: 1 });

    await qr.revoke(asset.id, actor);
    expect(await state(asset.id)).toMatchObject({ token: null, rotations: 2, movements: 1, audits: 2 });
  });

  it('si falla el log de rotación, el token no queda emitido ni el movimiento escrito', async () => {
    const asset = await assets.create(
      { ...base, description: 'QR con fallo', acquisitionDate: '2024-01-01' },
      actor,
    );
    await dataSource.query(`
      CREATE OR REPLACE FUNCTION it_fail_rotation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'fallo simulado en qr_token_rotation_log';
      END; $$ LANGUAGE plpgsql`);
    await dataSource.query(
      'CREATE TRIGGER it_fail_rotation BEFORE INSERT ON qr_token_rotation_log FOR EACH ROW EXECUTE FUNCTION it_fail_rotation()',
    );
    try {
      await expect(qr.issue(asset.id, actor, false, 256)).rejects.toThrow(/fallo simulado/);
      expect(await state(asset.id)).toEqual({ token: null, rotations: 0, movements: 0, audits: 0 });
    } finally {
      await dataSource.query('DROP TRIGGER it_fail_rotation ON qr_token_rotation_log');
    }
  });
});
