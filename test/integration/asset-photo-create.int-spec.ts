import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { storageDate, storageYear } from '../../src/shared/storage/storage-keys.js';
import {
  assignTestHead,
  createActor,
  createPermissionRole,
  openTestSession,
  scalar,
  useSharedStorage,
} from './helpers.js';

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const jpeg = (width = 48, height = 36): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 200 } } })
    .jpeg()
    .toBuffer();

describe('Alta de activo con foto pendiente o de la galería (HTTP real + PostgreSQL real + almacenamiento local)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let root: string;
  let centerA: string;
  let centerB: string;
  let categoryId: string;
  let acquisitionTypeId: string;
  let fileA: string;
  let fileB: string;
  const tokens: Record<string, string> = {};
  const year = storageYear(new Date());
  const today = storageDate(new Date());

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });

  const tokenFor = async (user: AuthenticatedUser) =>
    app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });

  const grant = (userId: string, role: string, scopeType = 'GLOBAL', scopeId: string | null = null) =>
    dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, $2, $3 FROM role WHERE code = $4`,
      [userId, scopeType, scopeId, role],
    );

  const body = (description: string, costCenterId: string, extra: Record<string, unknown> = {}) => ({
    description,
    categoryId,
    costCenterId,
    acquisitionTypeId,
    acquisitionDate: '2026-02-10',
    ...extra,
  });

  const stage = async (who = 'director') => {
    const response = await http().post('/api/v1/asset-photos/staged').set(auth(who)).attach('file', await jpeg(), 'alta.jpg');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.token as string;
  };

  const countByDescription = (description: string) =>
    scalar<number>(dataSource, 'SELECT count(*)::int FROM asset WHERE description = $1', [description]);

  const uploadTo = async (assetId: string) => {
    const response = await http()
      .post(`/api/v1/assets/${assetId}/photos`)
      .set(auth('director'))
      .attach('file', await jpeg(), 'galeria.jpg');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.fileId as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    root = await useSharedStorage(dataSource);

    centerA = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('ALTA-A', 'Centro A de altas') RETURNING id`,
    );
    centerB = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('ALTA-B', 'Centro B de altas') RETURNING id`,
    );
    await assignTestHead(dataSource, [centerA, centerB]);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('ALTA-FOTO', 'Con foto obligatoria', TRUE) RETURNING id`,
    );
    acquisitionTypeId = await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`);

    const director = await createActor(dataSource);
    await grant(director.id, 'INTERNAL_CONTROL_DIRECTOR');
    tokens['director'] = await tokenFor(director);

    const scoped = await createActor(dataSource);
    await grant(scoped.id, 'VIEWER', 'COST_CENTER', centerA);
    await grant(scoped.id, await createPermissionRole(dataSource, ['asset:create:global', 'asset:update:global']));
    tokens['registradorA'] = await tokenFor(scoped);

    const other = await createActor(dataSource);
    await grant(other.id, 'INTERNAL_CONTROL_DIRECTOR');
    tokens['otro'] = await tokenFor(other);

    const insertAsset = (code: string, centerId: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
           current_cost_center_id, created_by)
         VALUES ($1, $2, $3, $4, '2021-03-01', $5, $6)
         RETURNING id`,
        [code, `Activo de galería ${code}`, categoryId, acquisitionTypeId, centerId, director.id],
      );
    fileA = await uploadTo(await insertAsset('ALTA-GAL-A', centerA));
    fileB = await uploadTo(await insertAsset('ALTA-GAL-B', centerB));
  });

  afterAll(async () => {
    await app.close();
  });

  it('la categoría exige foto: sin foto el alta responde 400 ASSET_PHOTO_REQUIRED', async () => {
    const response = await http().post('/api/v1/assets').set(auth('director')).send(body('Sin foto', centerA));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ASSET_PHOTO_REQUIRED');
    expect(await countByDescription('Sin foto')).toBe(0);
  });

  it('con foto pendiente: queda en assets/<año>/<centro>/<activo>_<fecha>_1.jpg como principal y el temporal se borra', async () => {
    const token = await stage();
    const stagedPath = join(root, `assets/_pendientes/${token}`);
    expect(await exists(stagedPath)).toBe(true);

    const response = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Con foto pendiente', centerA, { stagedPhotoToken: token }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const assetId = response.body.data.id as string;
    const code = response.body.data.internalCode as string;

    const photos = (await dataSource.query(
      `SELECT ph.is_primary, f.storage_key, f.origin_asset_id, f.cost_center_id
       FROM asset_photo ph JOIN photo_file f ON f.id = ph.file_id
       WHERE ph.asset_id = $1 AND ph.unlinked_at IS NULL`,
      [assetId],
    )) as Array<{ is_primary: boolean; storage_key: string; origin_asset_id: string; cost_center_id: string }>;
    const key = `assets/${year}/ALTA-A/${code}_${today}_1.jpg`;
    expect(photos).toEqual([{ is_primary: true, storage_key: key, origin_asset_id: assetId, cost_center_id: centerA }]);
    expect(await exists(join(root, key))).toBe(true);
    expect(await exists(stagedPath)).toBe(false);
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM photo_staged_upload WHERE id = $1', [token])).toBe(0);

    const list = await http().get(`/api/v1/assets/${assetId}/photos`).set(auth('director'));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ isPrimary: true, contentType: 'image/jpeg' });

    const again = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Token repetido', centerA, { stagedPhotoToken: token }));
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('ASSET_PHOTO_TOKEN_INVALID');
    expect(again.body.error.message).toBe('La foto que subió ya no sirve. Súbala de nuevo.');
    expect(await countByDescription('Token repetido')).toBe(0);
  });

  it('token inexistente, de otro usuario o vencido: 400 ASSET_PHOTO_TOKEN_INVALID y no se crea el activo', async () => {
    const unknown = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Token malo', centerA, { stagedPhotoToken: randomUUID() }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('ASSET_PHOTO_TOKEN_INVALID');

    const foreign = await stage('otro');
    const notMine = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Token malo', centerA, { stagedPhotoToken: foreign }));
    expect(notMine.body.error.code).toBe('ASSET_PHOTO_TOKEN_INVALID');

    const expired = await stage();
    await dataSource.query(`UPDATE photo_staged_upload SET uploaded_at = NOW() - interval '25 hours' WHERE id = $1`, [
      expired,
    ]);
    const late = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Token malo', centerA, { stagedPhotoToken: expired }));
    expect(late.body.error.code).toBe('ASSET_PHOTO_TOKEN_INVALID');
    expect(await countByDescription('Token malo')).toBe(0);
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM photo_staged_upload WHERE id = $1', [foreign])).toBe(1);
  });

  it('con una foto de la galería: la vincula como principal sin copiar el archivo', async () => {
    const files = () => scalar<number>(dataSource, 'SELECT count(*)::int FROM photo_file');
    const before = await files();
    const response = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Con foto de galería', centerB, { photoFileId: fileA }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const assetId = response.body.data.id as string;
    const linked = (await dataSource.query(
      'SELECT file_id, is_primary FROM asset_photo WHERE asset_id = $1 AND unlinked_at IS NULL',
      [assetId],
    )) as Array<{ file_id: string; is_primary: boolean }>;
    expect(linked).toEqual([{ file_id: fileA, is_primary: true }]);
    expect(await files()).toBe(before);
    const audits = await scalar<number>(
      dataSource,
      `SELECT count(*)::int FROM audit_log WHERE action = 'ASSET_PHOTO_LINK' AND entity_id = $1`,
      [assetId],
    );
    expect(audits).toBe(1);
  });

  it('una foto fuera del alcance de lectura: 404 ASSET_PHOTO_FILE_NOT_FOUND. Dentro del alcance sí la usa', async () => {
    const outside = await http()
      .post('/api/v1/assets')
      .set(auth('registradorA'))
      .send(body('Galería ajena', centerA, { photoFileId: fileB }));
    expect(outside.status).toBe(404);
    expect(outside.body.error.code).toBe('ASSET_PHOTO_FILE_NOT_FOUND');
    expect(await countByDescription('Galería ajena')).toBe(0);

    const missing = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Galería ajena', centerA, { photoFileId: randomUUID() }));
    expect(missing.body.error.code).toBe('ASSET_PHOTO_FILE_NOT_FOUND');

    const inside = await http()
      .post('/api/v1/assets')
      .set(auth('registradorA'))
      .send(body('Galería propia', centerA, { photoFileId: fileA }));
    expect(inside.status, JSON.stringify(inside.body)).toBe(201);
  });

  it('dos fotos a la vez: 400 VALIDATION_FAILED. La edición no acepta los campos nuevos', async () => {
    const token = await stage();
    const both = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Dos fotos', centerA, { stagedPhotoToken: token, photoFileId: fileA }));
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe('VALIDATION_FAILED');
    expect(await countByDescription('Dos fotos')).toBe(0);

    const created = await http()
      .post('/api/v1/assets')
      .set(auth('director'))
      .send(body('Para editar', centerA, { stagedPhotoToken: token }));
    expect(created.status).toBe(201);
    const patch = await http()
      .patch(`/api/v1/assets/${created.body.data.id as string}`)
      .set(auth('director'))
      .send({ photoFileId: fileA });
    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe('VALIDATION_FAILED');
  });
});
