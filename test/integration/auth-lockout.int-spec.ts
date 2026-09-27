import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { HashService } from '../../src/shared/crypto/hash.service.js';
import { scalar } from './helpers.js';

const PASSWORD = 'Clave-Segura-2026!';
const WRONG_PASSWORD = 'Clave-Incorrecta-2026!';
const MINUTE = 60_000;

/**
 * BE-04: bloqueo temporal por cuenta, persistente en la BD, para contraseña, TOTP y códigos de recuperación.
 * Cada intento sale de una IP distinta (X-Forwarded-For desde loopback, que TRUST_PROXY por defecto acepta): el
 * throttler por IP nunca interviene, solo el contador por cuenta.
 */
describe('Bloqueo por cuenta en login y MFA (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let hashes: HashService;
  let ipCounter = 0;

  interface TestUser {
    readonly id: string;
    readonly username: string;
  }

  const nextIp = (): string => {
    ipCounter += 1;
    return `203.0.${Math.floor(ipCounter / 250) + 100}.${(ipCounter % 250) + 1}`;
  };

  const post = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).post(`/api/v1${path}`).set('X-Forwarded-For', nextIp());
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  const login = (username: string, password: string) => post('/auth/login').send({ username, password });

  const createUser = async (): Promise<TestUser> => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Prueba', $1, $2) RETURNING id`,
      [`Bloqueo ${suffix}`, `lock.${suffix}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [personId, `lock.${suffix}`, await hashes.hash(PASSWORD)],
    );
    return { id, username: `lock.${suffix}` };
  };

  const lockRow = async (subject: string, factor: 'PASSWORD' | 'MFA') => {
    const [row] = (await dataSource.query(
      'SELECT failed_count, lock_level, locked_until FROM auth_attempt_lockout WHERE subject = $1 AND factor = $2',
      [subject, factor],
    )) as Array<{ failed_count: number; lock_level: number; locked_until: Date | null }>;
    return row ?? null;
  };

  const expireLock = (subject: string, factor: 'PASSWORD' | 'MFA') =>
    dataSource.query(
      `UPDATE auth_attempt_lockout
       SET locked_until = NOW() - interval '1 second', window_started_at = NOW() - interval '1 hour'
       WHERE subject = $1 AND factor = $2`,
      [subject, factor],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    hashes = app.get(HashService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('contraseña', () => {
    it('5 fallos desde IP distintas bloquean la cuenta 15 min, aunque la 6.ª contraseña sea correcta', async () => {
      const user = await createUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await login(user.username, WRONG_PASSWORD);
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
      }
      const blocked = await login(user.username, PASSWORD);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');

      const row = await lockRow(`user:${user.id}`, 'PASSWORD');
      expect(row?.lock_level).toBe(1);
      const remaining = new Date(row?.locked_until ?? 0).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(14 * MINUTE);
      expect(remaining).toBeLessThanOrEqual(15 * MINUTE);

      // También por correo: el contador es de la cuenta, no del texto tecleado.
      const byEmail = await login(`${user.username}@unac.edu.co`, PASSWORD);
      expect(byEmail.status).toBe(429);
    });

    it('el bloqueo es temporal: vencido, la contraseña correcta entra y el contador se borra', async () => {
      const user = await createUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(user.username, WRONG_PASSWORD);
      }
      expect((await login(user.username, PASSWORD)).status).toBe(429);
      await expireLock(`user:${user.id}`, 'PASSWORD');
      const response = await login(user.username, PASSWORD);
      expect(response.status).toBe(200);
      expect(await lockRow(`user:${user.id}`, 'PASSWORD')).toBeNull();
    });

    it('el bloqueo siguiente dura el doble (backoff), nunca es permanente', async () => {
      const user = await createUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(user.username, WRONG_PASSWORD);
      }
      await expireLock(`user:${user.id}`, 'PASSWORD');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(user.username, WRONG_PASSWORD)).status).toBe(401);
      }
      const row = await lockRow(`user:${user.id}`, 'PASSWORD');
      expect(row?.lock_level).toBe(2);
      const remaining = new Date(row?.locked_until ?? 0).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(29 * MINUTE);
      expect(remaining).toBeLessThanOrEqual(30 * MINUTE);
    });

    it('un inicio correcto antes del umbral reinicia el contador', async () => {
      const user = await createUser();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await login(user.username, WRONG_PASSWORD);
      }
      expect((await login(user.username, PASSWORD)).status).toBe(200);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await login(user.username, WRONG_PASSWORD)).status).toBe(401);
      }
      expect((await login(user.username, PASSWORD)).status).toBe(200);
    });

    it('una cuenta inexistente responde exactamente igual (sin enumeración)', async () => {
      const ghost = `no.existe.${randomUUID().slice(0, 8)}`;
      const real = await createUser();
      const sequence = async (username: string) => {
        const seen: Array<{ status: number; code: string }> = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const response = await login(username, WRONG_PASSWORD);
          seen.push({ status: response.status, code: response.body.error?.code as string });
        }
        return seen;
      };
      const ghostSeq = await sequence(ghost);
      const realSeq = await sequence(real.username);
      expect(ghostSeq).toEqual(realSeq);
      expect(ghostSeq.at(-1)).toEqual({ status: 429, code: 'TOO_MANY_ATTEMPTS' });
      // Lo guardado para la cuenta inexistente es un hash, no el identificador.
      const stored = (await dataSource.query(
        `SELECT subject FROM auth_attempt_lockout WHERE subject LIKE 'id:%'`,
      )) as Array<{ subject: string }>;
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.some((row) => row.subject.includes(ghost))).toBe(false);
    });

    it('audita el bloqueo sin contraseñas ni identificadores en claro', async () => {
      const user = await createUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(user.username, WRONG_PASSWORD);
      }
      await login(user.username, PASSWORD);
      const rows = (await dataSource.query(
        `SELECT action, changes FROM audit_log WHERE entity_id = $1 AND action IN ('LOGIN_LOCKED', 'LOGIN_FAILED') ORDER BY id`,
        [user.id],
      )) as Array<{ action: string; changes: Record<string, unknown> }>;
      const locked = rows.filter((row) => row.action === 'LOGIN_LOCKED');
      expect(locked).toHaveLength(1);
      expect(locked[0]?.changes).toMatchObject({ factor: 'PASSWORD' });
      expect(rows.at(-1)?.changes).toMatchObject({ reason: 'ACCOUNT_LOCKED' });
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain(WRONG_PASSWORD);
    });
  });

  describe('segundo factor', () => {
    const enrolledUser = async (): Promise<{ user: TestUser; secret: string; codes: string[] }> => {
      const user = await createUser();
      const session = await login(user.username, PASSWORD);
      expect(session.status).toBe(200);
      const token = session.body.data.accessToken as string;
      const started = await post('/auth/me/mfa/enrollment', token).send({});
      expect(started.status).toBe(200);
      const secret = started.body.data.secret as string;
      const confirmed = await post('/auth/me/mfa/enrollment/confirm', token).send({ code: await generate({ secret }) });
      expect(confirmed.status).toBe(200);
      return { user, secret, codes: confirmed.body.data.recoveryCodes as string[] };
    };

    const challenge = async (user: TestUser): Promise<string> => {
      const response = await login(user.username, PASSWORD);
      expect(response.body.data).toMatchObject({ requiresMfa: true });
      return response.body.data.mfaChallengeToken as string;
    };

    const wrongTotp = async (secret: string): Promise<string> =>
      String((Number(await generate({ secret })) + 500_000) % 1_000_000).padStart(6, '0');

    it('5 TOTP erróneos con desafíos e IP distintos bloquean MFA, aunque el siguiente código sea correcto', async () => {
      const { user, secret, codes } = await enrolledUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await post('/auth/mfa/verify', await challenge(user)).send({ code: await wrongTotp(secret) });
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('MFA_CODE_INVALID');
      }
      const blocked = await post('/auth/mfa/verify', await challenge(user)).send({ code: await generate({ secret }) });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');

      // El código de recuperación comparte el contador: tampoco sirve mientras dure el bloqueo, ni se consume.
      const recovery = await post('/auth/mfa/recovery', await challenge(user)).send({ recoveryCode: codes[0] });
      expect(recovery.status).toBe(429);
      expect(
        await scalar<number>(dataSource, 'SELECT count(*)::int FROM mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL', [user.id]),
      ).toBe(codes.length);

      await expireLock(`user:${user.id}`, 'MFA');
      const verified = await post('/auth/mfa/verify', await challenge(user)).send({ code: await generate({ secret }) });
      expect(verified.status).toBe(200);
      expect(await lockRow(`user:${user.id}`, 'MFA')).toBeNull();
    });

    it('los códigos de recuperación erróneos cuentan para el mismo bloqueo', async () => {
      const { user } = await enrolledUser();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await post('/auth/mfa/recovery', await challenge(user)).send({ recoveryCode: 'ZZZZ-ZZZZ-ZZZZ' });
        expect(response.status).toBe(401);
      }
      const row = await lockRow(`user:${user.id}`, 'MFA');
      expect(row?.lock_level).toBe(1);
      expect(new Date(row?.locked_until ?? 0).getTime()).toBeGreaterThan(Date.now());
    });
  });
});
