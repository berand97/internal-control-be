import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { buildCorsOptions } from '../../src/common/http/cors.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';
import {
  SESSION_STATE_TTL_MS,
  SessionStateService,
} from '../../src/modules/auth/services/session-state.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { HashService } from '../../src/shared/crypto/hash.service.js';
import { MailService } from '../../src/shared/mail/mail.service.js';
import { openTestSession, scalar, withGrantReason } from './helpers.js';

const PASSWORD = 'Clave-Segura-2026!';
const WRONG_PASSWORD = 'Clave-Incorrecta-2026!';
const FRONTEND_ORIGIN = 'http://localhost:4200';
const HOUR = 3_600_000;

interface TestUser {
  readonly id: string;
  readonly personId: string;
  readonly username: string;
  readonly email: string;
}

/**
 * Segunda pasada de seguridad sobre autenticación y administración de usuarios (BE-07, BE-08, BE-09, BE-11, BE-13,
 * BE-14 y el código de bloqueo por cuenta), por HTTP real contra PostgreSQL real. Cada prueba reproduce el escenario
 * del hallazgo y comprueba que el flujo legítimo sigue funcionando.
 */
describe('Endurecimiento de sesión, rango y MFA (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let tokens: TokenService;
  let hashes: HashService;
  let ipCounter = 0;

  const nextIp = (): string => {
    ipCounter += 1;
    return `192.0.${Math.floor(ipCounter / 250) + 1}.${(ipCounter % 250) + 1}`;
  };
  const http = () => request(app.getHttpServer());
  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    token?: string,
    ip = nextIp(),
  ) => {
    const pending = withGrantReason(method, path, http()[method](`/api/v1${path}`).set('X-Forwarded-For', ip));
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };
  const login = (username: string, password: string, ip = nextIp()) =>
    call('post', '/auth/login', undefined, ip).send({ username, password });

  const roleId = (code: string): Promise<string> =>
    scalar<string>(dataSource, 'SELECT id FROM role WHERE code = $1', [code]);

  const createUser = async (
    roleCodes: ReadonlyArray<string>,
    options: { readonly status?: string; readonly mfa?: boolean } = {},
  ): Promise<TestUser> => {
    const tag = randomUUID().slice(0, 8);
    const email = `sec2.${tag}@unac.edu.co`;
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Prueba', $1, $2) RETURNING id`,
      [`Sec2 ${tag}`, email],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status, mfa_enabled)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        personId,
        `sec2.${tag}`,
        await hashes.hash(PASSWORD),
        options.status ?? 'ACTIVE',
        options.mfa === true,
      ],
    );
    for (const code of roleCodes) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [id, code],
      );
    }
    return { id, personId, username: `sec2.${tag}`, email };
  };

  /** Token con sesión real (familia ACTIVE). mfa: sesión verificada con segundo factor (para el reset de MFA). */
  const tokenFor = async (
    user: TestUser,
    roles: ReadonlyArray<string>,
    mfa = false,
  ): Promise<string> =>
    tokens.signAccessToken({
      id: user.id,
      personId: user.personId,
      username: user.username,
      roles: [...roles],
      scopes: [{ type: 'GLOBAL', id: null }],
      mustChangePassword: false,
      sessionId: await openTestSession(dataSource, user.id, {
        mfaVerified: mfa,
      }),
    });

  const superAdmin = async (): Promise<{ user: TestUser; token: string }> => {
    const user = await createUser(['SUPER_ADMIN'], { mfa: true });
    return { user, token: await tokenFor(user, ['SUPER_ADMIN'], true) };
  };

  /** Rol administrable propio (nivel 1, bajo SUPER_ADMIN) con los permisos dados. */
  const createRole = async (
    permissions: ReadonlyArray<string>,
    options: {
      readonly level?: number;
      readonly assignable?: boolean;
      readonly maxUsers?: number | null;
    } = {},
  ): Promise<{ id: string; code: string }> => {
    const code = `SEC2_${randomUUID().slice(0, 8).toUpperCase()}`;
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO role (code, name, hierarchy_level, is_system, is_assignable, max_concurrent_users, superior_role_id)
       VALUES ($1, $1, $2, FALSE, $3, $4, (SELECT id FROM role WHERE code = 'SUPER_ADMIN')) RETURNING id`,
      [
        code,
        options.level ?? 1,
        options.assignable ?? true,
        options.maxUsers ?? null,
      ],
    );
    for (const permission of permissions) {
      await dataSource.query(
        'INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = $2',
        [id, permission],
      );
    }
    return { id, code };
  };

  const assignmentOf = (userId: string, code: string): Promise<string> =>
    scalar<string>(
      dataSource,
      `SELECT ur.id FROM user_role ur JOIN role r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code = $2 AND ur.revoked_at IS NULL`,
      [userId, code],
    );

  const statusOf = (userId: string): Promise<string> =>
    scalar<string>(
      dataSource,
      'SELECT status::text FROM app_user WHERE id = $1',
      [userId],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(
      app,
      app
        .get(ConfigService<AppConfig, true>)
        .getOrThrow('trustProxy', { infer: true }),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    // La misma configuración de CORS que main.ts.
    app.enableCors(buildCorsOptions([FRONTEND_ORIGIN]));
    await app.init();
    dataSource = app.get(DataSource);
    tokens = app.get(TokenService);
    hashes = app.get(HashService);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('BE-09: el access token deja de servir en cuanto se revoca la sesión o cambia la cuenta', () => {
    it('logout: el mismo access token responde 401 SESSION_REVOKED de inmediato', async () => {
      const user = await createUser(['VIEWER']);
      const session = await login(user.username, PASSWORD);
      expect(session.status).toBe(200);
      const token = session.body.data.accessToken as string;
      expect((await call('get', '/auth/me', token)).status).toBe(200);

      expect((await call('post', '/auth/logout', token)).status).toBe(200);
      const after = await call('get', '/auth/me', token);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('SESSION_REVOKED');
      expect(after.body.action).toBe('REAUTH');
    });

    it('desactivación: el usuario desactivado pierde el acceso en la petición siguiente', async () => {
      const admin = await superAdmin();
      const victim = await createUser(['VIEWER']);
      const token = (await login(victim.username, PASSWORD)).body.data
        .accessToken as string;
      // Primera petición: el estado queda en caché.
      expect((await call('get', '/auth/me', token)).status).toBe(200);

      expect(
        (await call('post', `/users/${victim.id}/deactivate`, admin.token))
          .status,
      ).toBe(200);
      const after = await call('get', '/assets', token);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('SESSION_REVOKED');
    });

    it('suspensión hecha fuera de la API (en BD): efecto inmediato sin caché y, con caché, a más tardar al vencer su TTL', async () => {
      const cold = await createUser(['VIEWER']);
      const coldToken = (await login(cold.username, PASSWORD)).body.data
        .accessToken as string;
      await dataSource.query(
        `UPDATE app_user SET status = 'SUSPENDED' WHERE id = $1`,
        [cold.id],
      );
      expect((await call('get', '/auth/me', coldToken)).status).toBe(401);

      const warm = await createUser(['VIEWER']);
      const warmToken = (await login(warm.username, PASSWORD)).body.data
        .accessToken as string;
      expect((await call('get', '/auth/me', warmToken)).status).toBe(200);
      await dataSource.query(
        `UPDATE app_user SET status = 'SUSPENDED' WHERE id = $1`,
        [warm.id],
      );
      await new Promise((resolve) =>
        setTimeout(resolve, SESSION_STATE_TTL_MS + 250),
      );
      expect((await call('get', '/auth/me', warmToken)).status).toBe(401);
    });

    it('reset de MFA por un administrador: los tokens del afectado dejan de servir', async () => {
      const admin = await superAdmin();
      const target = await createUser(['VIEWER']);
      const token = (await login(target.username, PASSWORD)).body.data
        .accessToken as string;
      expect((await call('get', '/auth/me', token)).status).toBe(200);
      const reset = await call(
        'post',
        `/users/${target.id}/mfa/reset`,
        admin.token,
      ).send({
        reason: 'Pérdida del teléfono reportada a mesa de ayuda',
      });
      expect(reset.status).toBe(200);
      expect((await call('get', '/auth/me', token)).status).toBe(401);
    });

    it('un token con una sesión que no existe (o sin sid) no sirve', async () => {
      const user = await createUser(['VIEWER']);
      const forged = tokens.signAccessToken({
        id: user.id,
        personId: user.personId,
        username: user.username,
        roles: ['VIEWER'],
        scopes: [{ type: 'GLOBAL', id: null }],
        sessionId: randomUUID(),
      });
      expect((await call('get', '/auth/me', forged)).body.error.code).toBe(
        'SESSION_REVOKED',
      );
    });

    it('las decisiones de privilegio usan los roles vigentes en BD, no los del token', async () => {
      const admin = await superAdmin();
      // Actor con SUPER_ADMIN y un rol propio que da role:manage:global (así el guard de permisos no lo frena).
      const manager = await createRole([
        'role:manage:global',
        'role:read:global',
      ]);
      const actor = await createUser(['SUPER_ADMIN', manager.code]);
      const actorToken = await tokenFor(actor, ['SUPER_ADMIN', manager.code]);
      const target = await createRole([], { level: 2 });
      await dataSource.query(
        'UPDATE role SET superior_role_id = $1 WHERE id = $2',
        [manager.id, target.id],
      );

      const otherSuperior = await createRole([]);

      // Control: con SUPER_ADMIN vigente reorganiza (mueve el rol a otro superior). Re-apuntar al mismo superior ya
      // no es reorganizar (no se revalida nada), así que el control cambia de superior de verdad.
      const before = await call(
        'patch',
        `/roles/${target.id}`,
        actorToken,
      ).send({ superiorRoleId: otherSuperior.id });
      expect(before.status).toBe(200);

      const revoked = await call(
        'delete',
        `/users/${actor.id}/roles/${await assignmentOf(actor.id, 'SUPER_ADMIN')}`,
        admin.token,
      );
      expect(revoked.status).toBe(200);

      // El token todavía dice SUPER_ADMIN; la BD ya no.
      const after = await call('patch', `/roles/${target.id}`, actorToken).send(
        { superiorRoleId: manager.id },
      );
      expect(after.status).toBe(403);
      expect(after.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(after.body.error.message).not.toContain('Requiere permiso');
    });

    it('costo por petición de la verificación de sesión (se reporta, no se ajusta)', async () => {
      const user = await createUser(['VIEWER']);
      const sessionId = await openTestSession(dataSource, user.id);
      const sessions = app.get(SessionStateService);
      const rounds = 300;
      await sessions.resolve(user.id, sessionId);

      let started = performance.now();
      for (let round = 0; round < rounds; round += 1) {
        sessions.invalidate(user.id);
        expect(await sessions.resolve(user.id, sessionId)).not.toBeNull();
      }
      const uncachedMs = (performance.now() - started) / rounds;

      started = performance.now();
      for (let round = 0; round < rounds; round += 1) {
        await sessions.resolve(user.id, sessionId);
      }
      const cachedMs = (performance.now() - started) / rounds;

      console.info(
        `[BE-09] verificación de sesión: ${uncachedMs.toFixed(3)} ms/petición sin caché (1 consulta), ` +
          `${cachedMs.toFixed(4)} ms/petición con caché (${rounds} rondas)`,
      );
      expect(uncachedMs).toBeGreaterThan(cachedMs);
    });
  });

  describe('BE-07: administrar a otro usuario exige rango superior', () => {
    let helpdesk: { user: TestUser; token: string };
    let helpdeskRole: { id: string; code: string };

    beforeAll(async () => {
      // "Mesa de ayuda": nivel 1 (igual que el Director), con user:manage:global y role:assign:global.
      helpdeskRole = await createRole([
        'user:manage:global',
        'user:read:global',
        'role:assign:global',
      ]);
      const user = await createUser([helpdeskRole.code], { mfa: true });
      helpdesk = {
        user,
        token: await tokenFor(user, [helpdeskRole.code], true),
      };
    });

    it('sobre el Director (rango igual) no puede desactivar, reactivar, quitar roles, restablecer MFA ni editar', async () => {
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const directorRole = await assignmentOf(
        director.id,
        'INTERNAL_CONTROL_DIRECTOR',
      );
      const attempts = [
        () => call('post', `/users/${director.id}/deactivate`, helpdesk.token),
        () =>
          call(
            'delete',
            `/users/${director.id}/roles/${directorRole}`,
            helpdesk.token,
          ),
        () =>
          call('post', `/users/${director.id}/mfa/reset`, helpdesk.token).send({
            reason: 'Intento de mesa de ayuda sobre el Director',
          }),
        () =>
          call('patch', `/users/${director.id}`, helpdesk.token).send({
            firstName: 'Otro',
          }),
      ];
      for (const attempt of attempts) {
        const response = await attempt();
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('ROLE_PRIVILEGE_ESCALATION');
      }
      expect(await statusOf(director.id)).toBe('ACTIVE');
      expect(
        await assignmentOf(director.id, 'INTERNAL_CONTROL_DIRECTOR'),
      ).toBeTruthy();

      // Suspendido: tampoco puede reactivarlo.
      await dataSource.query(
        `UPDATE app_user SET status = 'SUSPENDED' WHERE id = $1`,
        [director.id],
      );
      const reactivate = await call(
        'post',
        `/users/${director.id}/reactivate`,
        helpdesk.token,
      );
      expect(reactivate.status).toBe(403);
      expect(reactivate.body.error.code).toBe('ROLE_PRIVILEGE_ESCALATION');
      expect(await statusOf(director.id)).toBe('SUSPENDED');
    });

    it('sobre un SUPER_ADMIN tampoco', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const response = await call(
        'post',
        `/users/${admin.id}/deactivate`,
        helpdesk.token,
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_PRIVILEGE_ESCALATION');
    });

    it('sobre un usuario de rango inferior sí (flujo legítimo)', async () => {
      const viewer = await createUser(['VIEWER']);
      expect(
        (await call('post', `/users/${viewer.id}/deactivate`, helpdesk.token))
          .status,
      ).toBe(200);
      expect(
        (await call('post', `/users/${viewer.id}/reactivate`, helpdesk.token))
          .status,
      ).toBe(200);
      expect(await statusOf(viewer.id)).toBe('ACTIVE');
      const revoked = await call(
        'delete',
        `/users/${viewer.id}/roles/${await assignmentOf(viewer.id, 'VIEWER')}`,
        helpdesk.token,
      );
      expect(revoked.status).toBe(200);
    });

    it('SUPER_ADMIN administra a todos: reactiva a un Director suspendido y desactiva a otro SUPER_ADMIN', async () => {
      const admin = await superAdmin();
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR'], {
        status: 'SUSPENDED',
      });
      expect(
        (await call('post', `/users/${director.id}/reactivate`, admin.token))
          .status,
      ).toBe(200);
      expect(await statusOf(director.id)).toBe('ACTIVE');
      const peer = await createUser(['SUPER_ADMIN']);
      expect(
        (await call('post', `/users/${peer.id}/deactivate`, admin.token))
          .status,
      ).toBe(200);
    });

    it('reactivar solo desde INACTIVE o SUSPENDED: una cuenta ACTIVE o pendiente responde 406 INVALID_STATE', async () => {
      const admin = await superAdmin();
      for (const status of ['ACTIVE', 'PENDING_ACTIVATION']) {
        const user = await createUser(['VIEWER'], { status });
        const response = await call(
          'post',
          `/users/${user.id}/reactivate`,
          admin.token,
        );
        expect(response.status).toBe(406);
        expect(response.body.error.code).toBe('INVALID_STATE');
        expect(await statusOf(user.id)).toBe(status);
      }
    });
  });

  describe('BE-08: la delegación respeta vigencia, isAssignable y cupo, y cae con su origen', () => {
    const inHours = (hours: number): string =>
      new Date(Date.now() + hours * HOUR).toISOString();
    const activeOf = (assignmentId: string): Promise<boolean> =>
      scalar<boolean>(
        dataSource,
        'SELECT revoked_at IS NULL FROM user_role WHERE id = $1',
        [assignmentId],
      );

    it('no dura más que la asignación de origen (400); dentro de su vigencia sí', async () => {
      const admin = await superAdmin();
      const holder = await createUser([]);
      const origin = await scalar<string>(
        dataSource,
        `INSERT INTO user_role (user_id, role_id, scope_type, valid_until)
         SELECT $1, id, 'GLOBAL', NOW() + interval '1 day' FROM role WHERE code = 'VIEWER' RETURNING id`,
        [holder.id],
      );
      const target = await createUser([]);
      const tooLong = await call(
        'post',
        `/users/${holder.id}/roles/${origin}/delegate`,
        admin.token,
      ).send({
        toUserId: target.id,
        validUntil: inHours(48),
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error.code).toBe(
        'DELEGATION_EXCEEDS_SOURCE_VALIDITY',
      );

      const ok = await call(
        'post',
        `/users/${holder.id}/roles/${origin}/delegate`,
        admin.token,
      ).send({
        toUserId: target.id,
        validUntil: inHours(12),
      });
      expect(ok.status).toBe(201);
    });

    it('un rol con max_concurrent_users = 1 ocupado no se delega (ROLE_MAX_USERS_REACHED)', async () => {
      const admin = await superAdmin();
      const single = await createRole(['asset:read:global'], {
        level: 2,
        maxUsers: 1,
      });
      const holder = await createUser([single.code]);
      const target = await createUser([]);
      const response = await call(
        'post',
        `/users/${holder.id}/roles/${await assignmentOf(holder.id, single.code)}/delegate`,
        admin.token,
      ).send({ toUserId: target.id, validUntil: inHours(24) });
      expect(response.status).toBe(406);
      expect(response.body.error.code).toBe('ROLE_MAX_USERS_REACHED');
      expect(
        await scalar<number>(
          dataSource,
          'SELECT count(*)::int FROM user_role WHERE user_id = $1',
          [target.id],
        ),
      ).toBe(0);
    });

    it('un rol no asignable no se delega (ROLE_NOT_ASSIGNABLE)', async () => {
      const admin = await superAdmin();
      const abstract = await createRole(['asset:read:global'], {
        level: 2,
        assignable: false,
      });
      const holder = await createUser([abstract.code]);
      const target = await createUser([]);
      const response = await call(
        'post',
        `/users/${holder.id}/roles/${await assignmentOf(holder.id, abstract.code)}/delegate`,
        admin.token,
      ).send({ toUserId: target.id, validUntil: inHours(24) });
      expect(response.status).toBe(406);
      expect(response.body.error.code).toBe('ROLE_NOT_ASSIGNABLE');
    });

    it('el cupo aguanta asignaciones concurrentes: de dos a la vez, entra una', async () => {
      const admin = await superAdmin();
      const single = await createRole(['asset:read:global'], {
        level: 2,
        maxUsers: 1,
      });
      const [first, second] = [await createUser([]), await createUser([])];
      const responses = await Promise.all(
        [first, second].map((user) =>
          call('post', `/users/${user.id}/roles`, admin.token).send({
            roleId: single.id,
            scopeType: 'GLOBAL',
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 406,
      ]);
      expect(
        await scalar<number>(
          dataSource,
          'SELECT count(*)::int FROM user_role WHERE role_id = $1 AND revoked_at IS NULL',
          [single.id],
        ),
      ).toBe(1);
    });

    it('revocar la asignación de origen revoca en cascada la delegación y la re-delegación', async () => {
      const admin = await superAdmin();
      const holder = await createUser(['VIEWER']);
      const [delegate, subDelegate] = [
        await createUser([]),
        await createUser([]),
      ];
      const origin = await assignmentOf(holder.id, 'VIEWER');
      const first = await call(
        'post',
        `/users/${holder.id}/roles/${origin}/delegate`,
        admin.token,
      ).send({
        toUserId: delegate.id,
        validUntil: inHours(24),
      });
      expect(first.status).toBe(201);
      const firstId = first.body.data.id as string;
      const second = await call(
        'post',
        `/users/${delegate.id}/roles/${firstId}/delegate`,
        admin.token,
      ).send({
        toUserId: subDelegate.id,
        validUntil: inHours(12),
      });
      expect(second.status).toBe(201);
      const secondId = second.body.data.id as string;

      expect(
        (
          await call(
            'delete',
            `/users/${holder.id}/roles/${origin}`,
            admin.token,
          )
        ).status,
      ).toBe(200);
      expect(await activeOf(origin)).toBe(false);
      expect(await activeOf(firstId)).toBe(false);
      expect(await activeOf(secondId)).toBe(false);
      const reason = await scalar<string>(
        dataSource,
        'SELECT revocation_reason FROM user_role WHERE id = $1',
        [firstId],
      );
      expect(reason).toContain('cascada');
    });
  });

  describe('BE-11: semillas TOTP cifradas y códigos de un solo uso', () => {
    const enroll = async (
      user: TestUser,
    ): Promise<{ secret: string; token: string }> => {
      const token = (await login(user.username, PASSWORD)).body.data
        .accessToken as string;
      const started = await call('post', '/auth/me/mfa/enrollment', token).send(
        {},
      );
      expect(started.status).toBe(200);
      const secret = started.body.data.secret as string;
      const pending = await scalar<string>(
        dataSource,
        'SELECT mfa_pending_secret FROM app_user WHERE id = $1',
        [user.id],
      );
      expect(pending.startsWith('enc.v1.')).toBe(true);
      expect(pending).not.toContain(secret);
      const confirmed = await call(
        'post',
        '/auth/me/mfa/enrollment/confirm',
        token,
      ).send({ code: await generate({ secret }) });
      expect(confirmed.status).toBe(200);
      return { secret, token };
    };

    it('en BD la semilla no es Base32 legible', async () => {
      const user = await createUser(['VIEWER']);
      const { secret } = await enroll(user);
      const stored = await scalar<string>(
        dataSource,
        'SELECT mfa_secret FROM app_user WHERE id = $1',
        [user.id],
      );
      expect(stored.startsWith('enc.v1.')).toBe(true);
      expect(stored).not.toContain(secret);
      expect(stored).not.toMatch(/^[A-Z2-7]+=*$/);
    });

    it('el mismo código TOTP no sirve dos veces dentro de su ventana', async () => {
      const user = await createUser(['VIEWER']);
      const { secret } = await enroll(user);
      // El código de la confirmación ya quedó usado: simula el paso de 30 s siguiente para el primer login.
      await dataSource.query(
        'UPDATE app_user SET mfa_last_totp_step = NULL WHERE id = $1',
        [user.id],
      );
      const code = await generate({ secret });

      const challenge = async () =>
        (await login(user.username, PASSWORD)).body.data
          .mfaChallengeToken as string;
      const first = await call(
        'post',
        '/auth/mfa/verify',
        await challenge(),
      ).send({ code });
      expect(first.status).toBe(200);
      const replay = await call(
        'post',
        '/auth/mfa/verify',
        await challenge(),
      ).send({ code });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('MFA_CODE_INVALID');
    });

    it('la confirmación del enrolamiento también consume el código', async () => {
      const user = await createUser(['VIEWER']);
      const { secret } = await enroll(user);
      const step = await scalar<string>(
        dataSource,
        'SELECT mfa_last_totp_step::text FROM app_user WHERE id = $1',
        [user.id],
      );
      expect(Number(step)).toBe(Math.floor(Date.now() / 1000 / 30));
      const challenge = (await login(user.username, PASSWORD)).body.data
        .mfaChallengeToken as string;
      // Solo si seguimos en el mismo paso de 30 s el código es el mismo que se usó al confirmar.
      if (Math.floor(Date.now() / 1000 / 30) === Number(step)) {
        const reuse = await call('post', '/auth/mfa/verify', challenge).send({
          code: await generate({ secret }),
        });
        expect(reuse.status).toBe(401);
      }
    });
  });

  describe('BE-13: sin enumeración de cuentas', () => {
    it('con contraseña incorrecta, una cuenta suspendida, inactiva o pendiente responde igual que una inexistente', async () => {
      const ghost = await login(
        `no.existe.${randomUUID().slice(0, 8)}`,
        WRONG_PASSWORD,
      );
      expect(ghost.status).toBe(401);
      for (const status of ['SUSPENDED', 'INACTIVE', 'PENDING_ACTIVATION']) {
        const user = await createUser(['VIEWER'], { status });
        const response = await login(user.username, WRONG_PASSWORD);
        expect({
          status: response.status,
          code: response.body.error.code,
        }).toEqual({
          status: ghost.status,
          code: ghost.body.error.code,
        });
      }
    });

    it('con la contraseña correcta sí se informa el estado', async () => {
      const user = await createUser(['VIEWER'], { status: 'SUSPENDED' });
      const response = await login(user.username, PASSWORD);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('USER_SUSPENDED');
    });

    it('forgot-password tarda lo mismo con un correo registrado que con uno inexistente, aunque el SMTP sea lento', async () => {
      const user = await createUser(['VIEWER']);
      const mail = app.get(MailService);
      const deliveries: Array<Promise<boolean>> = [];
      const spy = vi.spyOn(mail, 'sendPasswordReset').mockImplementation(() => {
        const delivery = new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), 1_500),
        );
        deliveries.push(delivery);
        return delivery;
      });
      const timed = async (email: string): Promise<number> => {
        const started = performance.now();
        const response = await call('post', '/auth/forgot-password').send({
          email,
        });
        expect(response.status).toBe(200);
        return performance.now() - started;
      };
      const median = (values: number[]): number =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      const known: number[] = [];
      const unknown: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        known.push(await timed(user.email));
        unknown.push(
          await timed(`nadie.${randomUUID().slice(0, 8)}@unac.edu.co`),
        );
      }
      console.info(
        `[BE-13] forgot-password mediana: registrado ${median(known).toFixed(1)} ms, inexistente ${median(unknown).toFixed(1)} ms (SMTP simulado de 1500 ms)`,
      );
      expect(Math.abs(median(known) - median(unknown))).toBeLessThan(50);
      expect(Math.max(...known)).toBeLessThan(1_500);
      // El correo sí sale (en segundo plano) y deja token y auditoría.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(5));
      await Promise.all(deliveries);
      await vi.waitFor(async () =>
        expect(
          await scalar<number>(
            dataSource,
            `SELECT count(*)::int FROM audit_log WHERE entity_id = $1 AND action = 'PWD_RESET_REQUEST'`,
            [user.id],
          ),
        ).toBe(5),
      );
      expect(
        await scalar<number>(
          dataSource,
          'SELECT count(*)::int FROM password_reset_token WHERE user_id = $1',
          [user.id],
        ),
      ).toBe(5);
      spy.mockRestore();
    });
  });

  describe('BE-14: la contraseña temporal de la invitación caduca', () => {
    const unitId = async (): Promise<string> => {
      const existing = await scalar<string | undefined>(
        dataSource,
        'SELECT id FROM organizational_unit WHERE is_active LIMIT 1',
      );
      if (existing) {
        return existing;
      }
      return scalar<string>(
        dataSource,
        `INSERT INTO organizational_unit (code, name, unit_type) VALUES ($1, 'Unidad de prueba', 'AREA') RETURNING id`,
        [`S2${randomUUID().slice(0, 6)}`],
      );
    };

    it('vence a las 72 h (INVITATION_EXPIRED) y el reenvío la renueva', async () => {
      const admin = await superAdmin();
      const passwords: string[] = [];
      const spy = vi
        .spyOn(app.get(MailService), 'sendUserInvitation')
        .mockImplementation((_email, _username, temporaryPassword) => {
          passwords.push(temporaryPassword);
          return Promise.resolve(true);
        });
      const tag = randomUUID().slice(0, 8);
      const email = `invitado.${tag}@unac.edu.co`;
      const created = await call('post', '/users', admin.token).send({
        firstName: 'Invitado',
        lastName: tag,
        email,
        organizationalUnitId: await unitId(),
        roleId: await roleId('VIEWER'),
      });
      expect(created.status).toBe(201);
      const userId = created.body.data.id as string;
      const expiresIn = async () =>
        new Date(
          await scalar<string>(
            dataSource,
            'SELECT invitation_expires_at FROM app_user WHERE id = $1',
            [userId],
          ),
        ).getTime() - Date.now();
      expect(await expiresIn()).toBeGreaterThan(71.9 * HOUR);
      expect(await expiresIn()).toBeLessThanOrEqual(72 * HOUR);

      // Vigente: entra y debe cambiar la contraseña.
      const fresh = await login(email, passwords[0] ?? '');
      expect(fresh.status).toBe(200);
      expect(fresh.body.data.user.mustChangePassword).toBe(true);
      // El login trae, además de los códigos, el nombre editable de cada rol (el de la BD).
      expect(fresh.body.data.user.roles).toEqual(['VIEWER']);
      expect(fresh.body.data.user.roleDetails).toEqual([
        { code: 'VIEWER', name: await scalar<string>(dataSource, `SELECT name FROM role WHERE code = 'VIEWER'`) },
      ]);
      const pendingToken = fresh.body.data.accessToken as string;

      // Vencida: ni login ni la sesión que abrió.
      await dataSource.query(
        `UPDATE app_user SET invitation_expires_at = NOW() - interval '1 second' WHERE id = $1`,
        [userId],
      );
      const expired = await login(email, passwords[0] ?? '');
      expect(expired.status).toBe(403);
      expect(expired.body.error.code).toBe('INVITATION_EXPIRED');
      expect((await call('get', '/auth/me', pendingToken)).status).toBe(401);
      // Con contraseña errónea sigue siendo 401 (no se revela el estado de la invitación).
      expect((await login(email, WRONG_PASSWORD)).status).toBe(401);

      // El reenvío genera otra contraseña y renueva el plazo.
      expect(
        (await call('post', `/users/${userId}/resend-invitation`, admin.token))
          .status,
      ).toBe(200);
      expect(await expiresIn()).toBeGreaterThan(71.9 * HOUR);
      const renewed = await login(email, passwords[1] ?? '');
      expect(renewed.status).toBe(200);
      expect((await login(email, passwords[0] ?? '')).status).toBe(401);
      spy.mockRestore();
    });

    it('cambiar la contraseña quita el plazo: la cuenta ya no tiene contraseña temporal', async () => {
      const user = await createUser([], { status: 'PENDING_ACTIVATION' });
      await dataSource.query(
        `UPDATE app_user SET must_change_password = TRUE, invitation_expires_at = NOW() + interval '1 hour' WHERE id = $1`,
        [user.id],
      );
      const token = (await login(user.username, PASSWORD)).body.data
        .accessToken as string;
      const changed = await call('post', '/auth/change-password', token).send({
        currentPassword: PASSWORD,
        newPassword: 'Otra-Clave-Segura-2026!',
      });
      expect(changed.status).toBe(200);
      const row = (await dataSource.query(
        'SELECT status::text AS status, must_change_password, invitation_expires_at FROM app_user WHERE id = $1',
        [user.id],
      )) as Array<{
        status: string;
        must_change_password: boolean;
        invitation_expires_at: Date | null;
      }>;
      expect(row[0]).toEqual({
        status: 'ACTIVE',
        must_change_password: false,
        invitation_expires_at: null,
      });
    });
  });

  describe('Bloqueo por cuenta: código propio, Retry-After y CORS', () => {
    it('la cuenta bloqueada responde ACCOUNT_TEMPORARILY_LOCKED con Retry-After legible desde el frontend', async () => {
      const user = await createUser(['VIEWER']);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(user.username, WRONG_PASSWORD)).status).toBe(401);
      }
      const blocked = await call('post', '/auth/login')
        .set('Origin', FRONTEND_ORIGIN)
        .send({ username: user.username, password: PASSWORD });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['access-control-allow-origin']).toBe(
        FRONTEND_ORIGIN,
      );
      const exposed = String(
        blocked.headers['access-control-expose-headers'] ?? '',
      )
        .split(',')
        .map((item) => item.trim());
      expect(exposed).toEqual(
        expect.arrayContaining(['Retry-After', 'Content-Disposition']),
      );
    });

    it('el throttler por IP sigue respondiendo TOO_MANY_ATTEMPTS', async () => {
      const ip = nextIp();
      let last: request.Response | null = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        last = await login(
          `nadie.${randomUUID().slice(0, 8)}`,
          WRONG_PASSWORD,
          ip,
        );
      }
      expect(last?.status).toBe(429);
      expect(last?.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    });

    it('un origen no permitido no recibe las cabeceras CORS', async () => {
      const response = await call('get', '/auth/me').set(
        'Origin',
        'https://evil.example',
      );
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
