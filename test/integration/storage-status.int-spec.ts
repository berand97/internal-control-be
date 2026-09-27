// Estado del almacenamiento y guardado del formulario con HTTP real y PostgreSQL real:
// - GET /storage/status devuelve el s3ForcePathStyle guardado y si hay credenciales (`*Set`), nunca su valor.
// - PATCH /storage/settings sin credenciales, con vacías, null o `****` conserva las guardadas.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { SecretCipherService } from '../../src/shared/crypto/secret-cipher.service.js';
import {
  createActor,
  openTestSession,
  SHARED_STORAGE_DIR,
  useSharedStorage,
} from './helpers.js';

const ACCESS_KEY = 'zqAK1-acceso-7Q2vY';
const SECRET_KEY = 'zqSK2-secreto-9Z4xW';
const GOOGLE_SECRET = 'zqGS3-google-5T1pL';
const ONEDRIVE_SECRET = 'zqOD4-onedrive-8K3mN';
const SECRETS = [ACCESS_KEY, SECRET_KEY, GOOGLE_SECRET, ONEDRIVE_SECRET];

interface StoredCredentials {
  readonly s3_access_key: string | null;
  readonly s3_secret_key: string | null;
  readonly google_client_secret: string | null;
  readonly onedrive_client_secret: string | null;
  readonly s3_force_path_style: boolean | null;
}

describe('Estado del almacenamiento: path style e indicadores de credenciales (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let token = '';
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const stored = async (): Promise<StoredCredentials> => {
    const [row] = (await dataSource.query(
      `SELECT s3_access_key, s3_secret_key, google_client_secret, onedrive_client_secret, s3_force_path_style
         FROM storage_settings`,
    )) as StoredCredentials[];
    if (!row) {
      throw new Error('storage_settings sin fila');
    }
    return row;
  };

  const revealed = async () => {
    const cipher = app.get(SecretCipherService);
    const row = await stored();
    return {
      accessKey: row.s3_access_key,
      secretKey: cipher.decrypt(row.s3_secret_key),
      googleSecret: cipher.decrypt(row.google_client_secret),
      onedriveSecret: cipher.decrypt(row.onedrive_client_secret),
    };
  };

  const expectNoSecretIn = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
      // Ni fragmentos: el mask de los Client ID usa los 2 primeros y 2 últimos caracteres.
      expect(text).not.toContain(secret.slice(0, 6));
      expect(text).not.toContain(secret.slice(-6));
    }
    expect(text).not.toContain('enc.v1.');
  };

  const saveAll = () =>
    http()
      .patch('/api/v1/storage/settings')
      .set(auth())
      .send({
        s3Bucket: 'bucket-status',
        s3AccessKey: ACCESS_KEY,
        s3SecretKey: SECRET_KEY,
        s3ForcePathStyle: true,
        googleClientId: 'cliente-status.apps.googleusercontent.com',
        googleClientSecret: GOOGLE_SECRET,
        onedriveClientId: 'onedrive-cliente-status',
        onedriveClientSecret: ONEDRIVE_SECRET,
      })
      .expect(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    await useSharedStorage(dataSource);
    const user = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'SUPER_ADMIN'`,
      [user.id],
    );
    token = app
      .get(TokenService)
      .signAccessToken({
        ...user,
        sessionId: await openTestSession(dataSource, user.id),
      });
  });

  afterAll(async () => {
    await dataSource.query(
      `UPDATE storage_settings SET driver = 'project', project_path = $1, s3_bucket = NULL, s3_access_key = NULL,
         s3_secret_key = NULL, s3_force_path_style = NULL, google_client_id = NULL, google_client_secret = NULL,
         onedrive_client_id = NULL, onedrive_client_secret = NULL`,
      [SHARED_STORAGE_DIR],
    );
    await app.close();
  });

  it('sin credenciales guardadas los indicadores son false', async () => {
    await dataSource.query(
      `UPDATE storage_settings SET s3_access_key = NULL, s3_secret_key = NULL, google_client_secret = NULL,
         onedrive_client_secret = NULL`,
    );
    const status = await http()
      .get('/api/v1/storage/status')
      .set(auth())
      .expect(200);
    expect(status.body.data).toMatchObject({
      s3AccessKeySet: false,
      s3SecretKeySet: false,
      googleClientSecretSet: false,
      onedriveClientSecretSet: false,
    });
  });

  it('GET /storage/status devuelve el s3ForcePathStyle guardado y los indicadores, sin ningún valor secreto', async () => {
    const saved = await saveAll();
    expectNoSecretIn(saved.body);
    for (const path of ['/api/v1/storage/status', '/api/v1/storage']) {
      const status = await http().get(path).set(auth()).expect(200);
      expect(status.body.data).toMatchObject({
        s3Bucket: 'bucket-status',
        s3ForcePathStyle: true,
        s3AccessKeySet: true,
        s3SecretKeySet: true,
        googleClientSecretSet: true,
        onedriveClientSecretSet: true,
      });
      expect(status.body.data).not.toHaveProperty('s3AccessKey');
      expect(status.body.data).not.toHaveProperty('s3SecretKey');
      expect(status.body.data).not.toHaveProperty('googleClientSecret');
      expect(status.body.data).not.toHaveProperty('onedriveClientSecret');
      expectNoSecretIn(status.body);
    }

    await dataSource.query(
      'UPDATE storage_settings SET s3_force_path_style = FALSE',
    );
    const off = await http()
      .get('/api/v1/storage/status')
      .set(auth())
      .expect(200);
    expect(off.body.data.s3ForcePathStyle).toBe(false);
  });

  it('PATCH sin credenciales conserva las guardadas y aplica el resto', async () => {
    await saveAll();
    const response = await http()
      .patch('/api/v1/storage/settings')
      .set(auth())
      .send({ s3Bucket: 'bucket-otro', s3ForcePathStyle: false })
      .expect(200);
    expect(response.body.data).toMatchObject({
      s3Bucket: 'bucket-otro',
      s3ForcePathStyle: false,
      s3AccessKeySet: true,
      s3SecretKeySet: true,
    });
    expect(await revealed()).toEqual({
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      googleSecret: GOOGLE_SECRET,
      onedriveSecret: ONEDRIVE_SECRET,
    });
  });

  it.each([
    ['vacías', ''],
    ['en blanco', '   '],
    ['null', null],
    ['con el marcador ****', '****'],
  ])(
    'PATCH con credenciales %s conserva las guardadas',
    async (_label, value) => {
      await saveAll();
      await http()
        .patch('/api/v1/storage/settings')
        .set(auth())
        .send({
          s3AccessKey: value,
          s3SecretKey: value,
          googleClientSecret: value,
          onedriveClientSecret: value,
          google: { clientSecret: value },
        })
        .expect(200);
      expect(await revealed()).toEqual({
        accessKey: ACCESS_KEY,
        secretKey: SECRET_KEY,
        googleSecret: GOOGLE_SECRET,
        onedriveSecret: ONEDRIVE_SECRET,
      });
    },
  );

  it('la respuesta coincide con StorageStatusDto publicado en OpenAPI en los cuatro endpoints', async () => {
    const openapi = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const schema = openapi.components?.schemas?.['StorageStatusDto'] as
      | {
          properties: Record<string, { nullable?: boolean }>;
          required: string[];
        }
      | undefined;
    expect(schema).toBeDefined();
    const declared = Object.keys(schema?.properties ?? {}).sort();
    expect([...(schema?.required ?? [])].sort()).toEqual(declared);
    for (const [method, path] of [
      ['get', '/api/v1/storage'],
      ['get', '/api/v1/storage/status'],
      ['patch', '/api/v1/storage'],
      ['patch', '/api/v1/storage/settings'],
    ] as const) {
      const operation = openapi.paths[path]?.[method];
      expect(JSON.stringify(operation?.responses['200'])).toContain(
        '#/components/schemas/StorageStatusDto',
      );
      const response = await http()
        [method](path)
        .set(auth())
        .send(method === 'patch' ? {} : undefined)
        .expect(200);
      const body = response.body.data as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(declared);
      for (const [key, value] of Object.entries(body)) {
        if (value === null) {
          expect(schema?.properties[key]?.nullable, key).toBe(true);
        }
      }
    }
  });

  it('PATCH con una credencial nueva la reemplaza y deja las demás', async () => {
    await saveAll();
    await http()
      .patch('/api/v1/storage/settings')
      .set(auth())
      .send({ s3SecretKey: 'secreto-s3-nuevo-3M8' })
      .expect(200);
    expect(await revealed()).toEqual({
      accessKey: ACCESS_KEY,
      secretKey: 'secreto-s3-nuevo-3M8',
      googleSecret: GOOGLE_SECRET,
      onedriveSecret: ONEDRIVE_SECRET,
    });
  });
});
