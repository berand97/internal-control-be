import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetPhotoStagedCleanupJob } from '../../src/modules/assets/jobs/asset-photo-staged-cleanup.job.js';
import { AssetPhotosService } from '../../src/modules/assets/services/asset-photos.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { storageDate, storageYear } from '../../src/shared/storage/storage-keys.js';
import { createActor, openTestSession, scalar, useSharedStorage } from './helpers.js';

const binary = (res: request.Response, callback: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const jpegWithGps = (width = 64, height = 48): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withExifMerge({
      IFD0: { Make: 'Camara', Model: 'Modelo secreto' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 15/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '75/1 34/1 0/1' },
    })
    .toBuffer();

const png = (width = 40, height = 30): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 60 } } })
    .png()
    .toBuffer();

describe('Fotos de activos por año y centro de costo (HTTP real + PostgreSQL real + almacenamiento local)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let root: string;
  let centerA: string;
  let centerB: string;
  let assetA: string;
  let assetA2: string;
  let assetB: string;
  let actor: AuthenticatedUser;
  const tokens: Record<string, string> = {};
  const year = storageYear(new Date());
  const today = storageDate(new Date());

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });
  const upload = (assetId: string, who: string, file: Buffer, name = 'foto.jpg', fields: Record<string, string> = {}) => {
    let pending = http().post(`/api/v1/assets/${assetId}/photos`).set(auth(who));
    for (const [field, value] of Object.entries(fields)) {
      pending = pending.field(field, value);
    }
    return pending.attach('file', file, name);
  };
  const image = (path: string, who: string, headers: Record<string, string> = {}) =>
    http().get(`/api/v1${path}`).set(auth(who)).set(headers).buffer(true).parse(binary);

  const tokenFor = async (user: AuthenticatedUser) =>
    app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });

  const userWith = async (name: string, role: string | null, scopeType = 'GLOBAL', scopeId: string | null = null) => {
    const user = await createActor(dataSource);
    if (role) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, $2, $3 FROM role WHERE code = $4`,
        [user.id, scopeType, scopeId, role],
      );
    }
    tokens[name] = await tokenFor(user);
    return user;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    root = await useSharedStorage(dataSource);

    const creator = await createActor(dataSource);
    centerA = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('FOTO-A', 'Centro A de fotos') RETURNING id`,
    );
    centerB = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('FOTO-B', 'Centro B de fotos') RETURNING id`,
    );
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('FOTOS', 'Fotos', FALSE) RETURNING id`,
    );
    const insertAsset = (code: string, centerId: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
           current_cost_center_id, created_by, data_quality_flags)
         VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2021-03-01', $4, $5, '{PHOTO_MISSING}')
         RETURNING id`,
        [code, `Activo con fotos ${code}`, categoryId, centerId, creator.id],
      );
    assetA = await insertAsset('FOTO-A-1', centerA);
    assetA2 = await insertAsset('FOTO-A-2', centerA);
    assetB = await insertAsset('FOTO-B-1', centerB);

    actor = await userWith('director', 'INTERNAL_CONTROL_DIRECTOR');
    await userWith('consultaA', 'VIEWER', 'COST_CENTER', centerA);
    await userWith('consultaB', 'VIEWER', 'COST_CENTER', centerB);
    await userWith('sinRol', null);
  });

  afterAll(async () => {
    await app.close();
  });

  let firstPhoto: { id: string; fileId: string; contentUrl: string; thumbnailUrl: string };
  let firstFileKey: string;

  it('sube una foto: queda en assets/<año>/<centro>/<activo>_<fecha>_1.jpg, con miniatura, como principal', async () => {
    const response = await upload(assetA, 'director', await jpegWithGps(), 'IMG_0001.jpg', { caption: 'Frente' });
    expect(response.status).toBe(201);
    const photo = response.body.data;
    expect(photo).toMatchObject({ assetId: assetA, isPrimary: true, caption: 'Frente', contentType: 'image/jpeg', legacyUrl: null });
    expect(photo.contentUrl).toBe(`/assets/${assetA}/photos/${photo.id}/content`);
    firstPhoto = photo;

    const [file] = (await dataSource.query('SELECT * FROM photo_file WHERE id = $1', [photo.fileId])) as Array<
      Record<string, unknown>
    >;
    firstFileKey = `assets/${year}/FOTO-A/FOTO-A-1_${today}_1.jpg`;
    expect(file).toMatchObject({
      storage_driver: 'project',
      storage_key: firstFileKey,
      thumb_key: `assets/miniaturas/${year}/FOTO-A/FOTO-A-1_${today}_1.webp`,
      cost_center_id: centerA,
      upload_year: Number(year),
      origin_asset_id: assetA,
      uploaded_by: actor.id,
    });
    expect(await exists(join(root, firstFileKey))).toBe(true);
    expect(await exists(join(root, String(file?.['thumb_key'])))).toBe(true);
    const flags = await scalar<string[]>(dataSource, 'SELECT data_quality_flags FROM asset WHERE id = $1', [assetA]);
    expect(flags).not.toContain('PHOTO_MISSING');
    const audits = await scalar<number>(
      dataSource,
      `SELECT count(*)::int FROM audit_log WHERE action = 'ASSET_PHOTO_UPLOAD' AND entity_id = $1`,
      [assetA],
    );
    expect(audits).toBe(1);
  });

  it('la foto guardada no trae EXIF ni GPS y la miniatura es WebP de 320 px como máximo', async () => {
    const stored = await readFile(join(root, firstFileKey));
    const metadata = await sharp(stored).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(stored.toString('latin1')).not.toContain('Modelo secreto');
    const big = await upload(assetA2, 'director', await png(3000, 1500), 'grande.png');
    expect(big.status).toBe(201);
    expect(big.body.data).toMatchObject({ width: 2560, height: 1280, contentType: 'image/png' });
    const thumb = await image(big.body.data.thumbnailUrl, 'director');
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(await sharp(thumb.body as Buffer).metadata()).toMatchObject({ format: 'webp', width: 320, height: 160 });
  });

  it('la segunda foto del mismo activo el mismo día lleva el número 2 y no cambia la principal', async () => {
    const response = await upload(assetA, 'director', await png(), 'otra.png');
    expect(response.status).toBe(201);
    expect(response.body.data.isPrimary).toBe(false);
    const key = await scalar<string>(dataSource, 'SELECT storage_key FROM photo_file WHERE id = $1', [
      response.body.data.fileId,
    ]);
    expect(key).toBe(`assets/${year}/FOTO-A/FOTO-A-1_${today}_2.png`);
  });

  it('bytes que no son JPG, PNG ni WebP: 400 FILE_TYPE_NOT_ALLOWED aunque el nombre diga .jpg', async () => {
    const html = Buffer.from('<!DOCTYPE html><html><body>hola</body></html>');
    const response = await upload(assetA, 'director', html, 'foto.jpg');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).gif().toBuffer();
    expect((await upload(assetA, 'director', gif, 'foto.png')).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('más de 10 MB: 400 FILE_TOO_LARGE', async () => {
    const huge = Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]);
    const response = await upload(assetA, 'director', huge, 'enorme.png');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('subir sin asset:update:global: 403', async () => {
    const response = await upload(assetA, 'consultaA', await png());
    expect(response.status).toBe(403);
  });

  it('ver la foto: private, ETag sha256, nosniff, 304 con If-None-Match y cada vista en la bitácora', async () => {
    const before = await scalar<number>(
      dataSource,
      `SELECT count(*)::int FROM audit_log WHERE action = 'ASSET_PHOTO_VIEW' AND entity_id = $1`,
      [assetA],
    );
    const response = await image(firstPhoto.contentUrl, 'consultaA');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toMatch(/^private/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const sha = await scalar<string>(dataSource, 'SELECT sha256 FROM photo_file WHERE id = $1', [firstPhoto.fileId]);
    expect(response.headers['etag']).toBe(`"${sha}"`);
    expect((response.body as Buffer).equals(await readFile(join(root, firstFileKey)))).toBe(true);
    const cached = await image(firstPhoto.contentUrl, 'consultaA', { 'If-None-Match': `"${sha}"` });
    expect(cached.status).toBe(304);
    const after = await scalar<number>(
      dataSource,
      `SELECT count(*)::int FROM audit_log WHERE action = 'ASSET_PHOTO_VIEW' AND entity_id = $1`,
      [assetA],
    );
    expect(after - before).toBe(2);
    const changes = await scalar<Record<string, unknown>>(
      dataSource,
      `SELECT changes FROM audit_log WHERE action = 'ASSET_PHOTO_VIEW' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [assetA],
    );
    expect(Object.keys(changes).sort()).toEqual(['fileId', 'photoId']);
  });

  it('las miniaturas, del activo o de la galería, no dejan fila en la bitácora', async () => {
    const views = () =>
      scalar<number>(dataSource, `SELECT count(*)::int FROM audit_log WHERE action = 'ASSET_PHOTO_VIEW'`);
    const before = await views();
    expect((await image(firstPhoto.thumbnailUrl, 'consultaA')).status).toBe(200);
    expect((await image(`/asset-photos/${firstPhoto.fileId}/thumbnail`, 'consultaA')).status).toBe(200);
    expect(await views()).toBe(before);
  });

  it('fuera de alcance: 404 como un activo inexistente. Sin permiso de lectura: 403', async () => {
    for (const path of [firstPhoto.contentUrl, firstPhoto.thumbnailUrl, `/assets/${assetA}/photos`]) {
      const outside = await image(path, 'consultaB');
      expect(outside.status).toBe(404);
      const denied = await image(path, 'sinRol');
      expect(denied.status).toBe(403);
    }
    const missing = await image(`/assets/${assetA}/photos/${randomUUID()}/content`, 'director');
    expect(missing.status).toBe(404);
  });

  it('lista las fotos del activo con la principal primero', async () => {
    const response = await http().get(`/api/v1/assets/${assetA}/photos`).set(auth('consultaA'));
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toMatchObject({ id: firstPhoto.id, isPrimary: true });
  });

  it('vincular a otro activo avisa con los códigos que ya la tienen. Repetir en el mismo activo: 409', async () => {
    const linked = await http()
      .post(`/api/v1/assets/${assetB}/photos/link`)
      .set(auth('director'))
      .send({ photoFileId: firstPhoto.fileId, primary: true });
    expect(linked.status).toBe(201);
    expect(linked.body.data.alsoLinkedTo).toEqual(['FOTO-A-1']);
    expect(linked.body.data.warning).toBe('Esta foto también está en el activo FOTO-A-1.');
    expect(linked.body.data.photo).toMatchObject({ assetId: assetB, fileId: firstPhoto.fileId, isPrimary: true });
    const flags = await scalar<string[]>(dataSource, 'SELECT data_quality_flags FROM asset WHERE id = $1', [assetB]);
    expect(flags).not.toContain('PHOTO_MISSING');

    const again = await http()
      .post(`/api/v1/assets/${assetB}/photos/link`)
      .set(auth('director'))
      .send({ photoFileId: firstPhoto.fileId });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ASSET_PHOTO_ALREADY_LINKED');

    const third = await http()
      .post(`/api/v1/assets/${assetA2}/photos/link`)
      .set(auth('director'))
      .send({ photoFileId: firstPhoto.fileId });
    expect(third.body.data.alsoLinkedTo).toEqual(['FOTO-A-1', 'FOTO-B-1']);
    expect(third.body.data.warning).toBe('Esta foto también está en los activos FOTO-A-1, FOTO-B-1.');
    expect(third.body.data.photo.isPrimary).toBe(false);

    const unknown = await http()
      .post(`/api/v1/assets/${assetB}/photos/link`)
      .set(auth('director'))
      .send({ photoFileId: randomUUID() });
    expect(unknown.status).toBe(404);
  });

  it('cambiar la principal deja una sola principal por activo', async () => {
    const list = await http().get(`/api/v1/assets/${assetA}/photos`).set(auth('director'));
    const second = list.body.data.find((photo: { isPrimary: boolean }) => !photo.isPrimary);
    const response = await http().patch(`/api/v1/assets/${assetA}/photos/${second.id}/primary`).set(auth('director'));
    expect(response.status).toBe(200);
    expect(response.body.data.isPrimary).toBe(true);
    const primaries = await scalar<number>(
      dataSource,
      'SELECT count(*)::int FROM asset_photo WHERE asset_id = $1 AND is_primary',
      [assetA],
    );
    expect(primaries).toBe(1);
    const report = await scalar<string>(
      dataSource,
      'SELECT fotografia_id FROM v_asset_report WHERE mov_id_activo = $1',
      [assetA],
    );
    expect(report).toBe(second.id);
  });

  it('quitar la foto solo la desvincula: el archivo sigue y la galería la conserva', async () => {
    const response = await http().delete(`/api/v1/assets/${assetA}/photos/${firstPhoto.id}`).set(auth('director'));
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(firstPhoto.id);
    expect(await exists(join(root, firstFileKey))).toBe(true);
    const list = await http().get(`/api/v1/assets/${assetA}/photos`).set(auth('director'));
    expect(list.body.data.map((photo: { id: string }) => photo.id)).not.toContain(firstPhoto.id);
    expect((await image(firstPhoto.contentUrl, 'director')).status).toBe(404);
    const again = await http().delete(`/api/v1/assets/${assetA}/photos/${firstPhoto.id}`).set(auth('director'));
    expect(again.status).toBe(404);

    const timeline = await http().get(`/api/v1/assets/${assetA}/timeline`).set(auth('director'));
    const photos = timeline.body.data.items.filter((event: { kind: string }) => event.kind === 'PHOTO');
    const removed = photos.find((event: { details: { photoId: string } }) => event.details.photoId === firstPhoto.id);
    expect(removed.details.contentUrl).toBeNull();
    expect(removed.details.unlinkedAt).not.toBeNull();
    const current = photos.find((event: { details: { photoId: string } }) => event.details.photoId !== firstPhoto.id);
    expect(current.details.contentUrl).toMatch(new RegExp(`^/assets/${assetA}/photos/[0-9a-f-]+/content$`));
  });

  it('galería: año por defecto el actual, filtro por centro y alcance del usuario', async () => {
    const all = await http().get('/api/v1/asset-photos').set(auth('director'));
    expect(all.status).toBe(200);
    expect(all.body.data.year).toBe(Number(year));
    expect(all.body.data.total).toBe(3);
    const first = all.body.data.items.find((item: { id: string }) => item.id === firstPhoto.fileId);
    expect(first).toMatchObject({
      originAssetCode: 'FOTO-A-1',
      linkedAssetCodes: ['FOTO-A-2', 'FOTO-B-1'],
      costCenterCode: 'FOTO-A',
      thumbnailUrl: `/asset-photos/${firstPhoto.fileId}/thumbnail`,
    });

    const old = await http().get('/api/v1/asset-photos').query({ year: 2001 }).set(auth('director'));
    expect(old.body.data.total).toBe(0);
    const byCenter = await http().get('/api/v1/asset-photos').query({ costCenterId: centerB }).set(auth('director'));
    expect(byCenter.body.data.total).toBe(0);

    const scopedA = await http().get('/api/v1/asset-photos').set(auth('consultaA'));
    expect(scopedA.body.data.total).toBe(3);
    const scopedB = await http().get('/api/v1/asset-photos').set(auth('consultaB'));
    expect(scopedB.body.data.total).toBe(0);
    const scopedFirst = scopedA.body.data.items.find((item: { id: string }) => item.id === firstPhoto.fileId);
    expect(scopedFirst.linkedAssetCodes).toEqual(['FOTO-A-2']);
    expect((await http().get('/api/v1/asset-photos').set(auth('sinRol'))).status).toBe(403);

    const paged = await http().get('/api/v1/asset-photos').query({ pageSize: 2, page: 2 }).set(auth('director'));
    expect(paged.body.data).toMatchObject({ page: 2, pageSize: 2, total: 3, hasNext: false });
    expect(paged.body.data.items).toHaveLength(1);
  });

  it('miniatura de la galería: visible por el centro de la foto o por un activo vinculado en alcance', async () => {
    const thumb = `/asset-photos/${firstPhoto.fileId}/thumbnail`;
    expect((await image(thumb, 'consultaA')).status).toBe(200);
    expect((await image(thumb, 'consultaB')).status).toBe(200);
    const onlyA = (await http().get('/api/v1/asset-photos').set(auth('director'))).body.data.items.find(
      (item: { linkedAssetCodes: string[] }) => item.linkedAssetCodes.length === 1 && item.linkedAssetCodes[0] === 'FOTO-A-1',
    );
    const denied = await image(`/asset-photos/${onlyA.id}/thumbnail`, 'consultaB');
    expect(denied.status).toBe(404);
    expect((await image(thumb, 'sinRol')).status).toBe(403);
  });

  it('foto pendiente: se guarda en assets/_pendientes/<token>, se termina en su llave final y se limpia', async () => {
    const staged = await http()
      .post('/api/v1/asset-photos/staged')
      .set(auth('director'))
      .attach('file', await jpegWithGps(), 'nueva.jpg');
    expect(staged.status).toBe(201);
    const token = staged.body.data.token as string;
    const stagedPath = join(root, `assets/_pendientes/${token}`);
    expect(await exists(stagedPath)).toBe(true);
    expect((await sharp(await readFile(stagedPath)).metadata()).exif).toBeUndefined();
    expect(Date.parse(staged.body.data.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    const service = app.get(AssetPhotosService);
    const other = await createActor(dataSource);
    await expect(service.finalizeStaged(token, assetB, other)).rejects.toMatchObject({
      code: 'ASSET_PHOTO_STAGED_NOT_FOUND',
    });
    const photo = await service.finalizeStaged(token, assetB, actor, { caption: 'Desde el alta' });
    expect(photo).toMatchObject({ assetId: assetB, caption: 'Desde el alta', isPrimary: false });
    const key = await scalar<string>(dataSource, 'SELECT storage_key FROM photo_file WHERE id = $1', [photo.fileId]);
    expect(key).toBe(`assets/${year}/FOTO-B/FOTO-B-1_${today}_1.jpg`);
    expect(await exists(join(root, key))).toBe(true);
    expect(await exists(stagedPath)).toBe(false);
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM photo_staged_upload WHERE id = $1', [token])).toBe(0);
    await expect(service.finalizeStaged(token, assetB, actor)).rejects.toMatchObject({
      code: 'ASSET_PHOTO_STAGED_NOT_FOUND',
    });
  });

  it('la limpieza diaria borra las pendientes de más de 24 horas y deja las recientes', async () => {
    const stage = async () =>
      (
        await http()
          .post('/api/v1/asset-photos/staged')
          .set(auth('director'))
          .attach('file', await png(), 'pendiente.png')
      ).body.data.token as string;
    const oldToken = await stage();
    const freshToken = await stage();
    await dataSource.query(`UPDATE photo_staged_upload SET uploaded_at = NOW() - interval '25 hours' WHERE id = $1`, [
      oldToken,
    ]);
    const service = app.get(AssetPhotosService);
    await expect(service.finalizeStaged(oldToken, assetB, actor)).rejects.toMatchObject({
      code: 'ASSET_PHOTO_STAGED_NOT_FOUND',
    });

    const removed = await app.get(AssetPhotoStagedCleanupJob).run();
    expect(removed).toBe(1);
    expect(await exists(join(root, `assets/_pendientes/${oldToken}`))).toBe(false);
    expect(await exists(join(root, `assets/_pendientes/${freshToken}`))).toBe(true);
    const left = (await dataSource.query('SELECT id FROM photo_staged_upload ORDER BY id')) as Array<{ id: string }>;
    expect(left.map((row) => row.id)).toEqual([freshToken]);
  });
});
