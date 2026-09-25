import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
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
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { HashService } from '../../src/shared/crypto/hash.service.js';
import { scalar } from './helpers.js';

const PASSWORD = 'Clave-Segura-2026!';
const RESET_REASON = 'Pérdida del celular reportada a mesa de ayuda, caso 2026-1432';

interface Schema {
  readonly $ref?: string;
  readonly allOf?: ReadonlyArray<Schema>;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: ReadonlyArray<unknown>;
  readonly properties?: Record<string, Schema>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
}

/** Misma comparación respuesta-real contra esquema publicado que document-openapi.int-spec.ts. */
const conform = (openapi: OpenAPIObject, value: unknown, schema: Schema, path: string, errors: string[]): void => {
  const components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
  const resolve = (item: Schema): Schema => {
    if (item.$ref) {
      return resolve(components[item.$ref.replace('#/components/schemas/', '')] ?? {});
    }
    const { allOf, ...own } = item;
    if (allOf) {
      const parts = [...allOf.map(resolve), own];
      return parts.reduce<Schema>(
        (merged, part) => ({
          ...merged,
          ...part,
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required ?? []), ...(part.required ?? [])],
          nullable: Boolean(merged.nullable || part.nullable),
        }),
        {},
      );
    }
    return item;
  };
  const resolved = resolve(schema);
  if (value === null) {
    if (!resolved.nullable) {
      errors.push(`${path}: es null y el esquema no lo declara nullable`);
    }
    return;
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} no está en el enum ${JSON.stringify(resolved.enum)}`);
  }
  const type = resolved.type ?? (resolved.properties ? 'object' : undefined);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: se esperaba arreglo`);
      return;
    }
    value.forEach((item, index) => conform(openapi, item, resolved.items ?? {}, `${path}[${index}]`, errors));
    return;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: se esperaba objeto`);
      return;
    }
    const declared = resolved.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!(key in declared)) {
        errors.push(`${path}.${key}: la respuesta la trae y el esquema no la declara`);
      }
    }
    for (const key of resolved.required ?? []) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: requerida en el esquema y ausente en la respuesta`);
      }
    }
    for (const [key, property] of Object.entries(declared)) {
      if (key in value) {
        conform(openapi, (value as Record<string, unknown>)[key], property, `${path}.${key}`, errors);
      }
    }
    return;
  }
  const expected: Record<string, (item: unknown) => boolean> = {
    string: (item) => typeof item === 'string',
    integer: (item) => Number.isInteger(item),
    number: (item) => typeof item === 'number',
    boolean: (item) => typeof item === 'boolean',
  };
  if (type && expected[type] && !expected[type](value)) {
    errors.push(`${path}: se esperaba ${type} y llegó ${typeof value}`);
  }
  if (!type && !resolved.enum) {
    errors.push(`${path}: el esquema no declara tipo (queda como Object en el cliente generado)`);
  }
};

/**
 * Desalineaciones previas a este trabajo, fuera de su zona (FeatureResponseDto.reason no declara 'DEFAULT'). Se
 * listan para que el test no las oculte en silencio ni falle por ellas; cualquier otra hace fallar.
 */
const KNOWN_FOREIGN_MISMATCH = /^GET \/api\/v1\/auth\/me 200\.data\.features\[\d+\]\.reason: "DEFAULT" no está en el enum/;

/** Rutas nuevas o cambiadas por este trabajo: toda respuesta 2xx observada en ellas se valida contra OpenAPI. */
const CONTRACT_ROUTES = [
  '/api/v1/auth/me',
  '/api/v1/auth/me/mfa/enrollment',
  '/api/v1/auth/me/mfa/enrollment/confirm',
  '/api/v1/auth/me/mfa/recovery-codes',
  '/api/v1/auth/me/mfa/disable',
  '/api/v1/auth/mfa/recovery',
  '/api/v1/auth/mfa/confirm',
  '/api/v1/users/{id}/mfa/reset',
];

interface Observed {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly body: unknown;
}

interface TestUser {
  readonly id: string;
  readonly personId: string;
  readonly username: string;
}

interface Session {
  readonly accessToken: string;
  readonly refreshCookie: string;
  readonly sessionId: string;
}

describe('MFA desde sesión, códigos de recuperación y reset administrativo (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let tokens: TokenService;
  let hashes: HashService;
  let ipCounter = 0;
  /** Todo secreto o código que vio el test: al final ninguno puede aparecer en audit_log. */
  const secretsSeen = new Set<string>();
  const observed: Observed[] = [];
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const observe = (method: string, path: string) => (response: request.Response) => {
    const route = `/api/v1${path.replace(UUID, '{id}')}`;
    // Solo 2xx: errorEnvelopeSchema() declara error como unknown en todo el API (ver reporte).
    if (CONTRACT_ROUTES.includes(route) && response.status < 300) {
      observed.push({ method, route, status: response.status, body: response.body as unknown });
    }
    return response;
  };

  const http = () => request(app.getHttpServer());
  /** IP distinta por llamada: el throttler de MFA (3 por 5 min por IP y ruta) no debe interferir salvo donde se prueba. */
  const nextIp = (): string => {
    ipCounter += 1;
    return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  };
  const post = (path: string, token?: string) => {
    const call = http().post(`/api/v1${path}`).set('X-Forwarded-For', nextIp()).set('User-Agent', 'vitest-mfa');
    const authorized = token ? call.set('Authorization', `Bearer ${token}`) : call;
    return {
      send: (body?: object) => (body === undefined ? authorized.send() : authorized.send(body)).then(observe('post', path)),
    };
  };
  const get = (path: string, token: string) =>
    http()
      .get(`/api/v1${path}`)
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${token}`)
      .then(observe('get', path));

  const totp = async (secret: string): Promise<string> => generate({ secret });
  const wrongTotp = async (secret: string): Promise<string> =>
    String((Number(await totp(secret)) + 1) % 1_000_000).padStart(6, '0');

  const createUser = async (roleCode: string | null): Promise<TestUser> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Prueba', $1, $2) RETURNING id`,
      [`MFA ${tag}`, `mfa.${tag}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [personId, `mfa.${tag}`, await hashes.hash(PASSWORD)],
    );
    if (roleCode) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [id, roleCode],
      );
    }
    return { id, personId, username: `mfa.${tag}` };
  };

  const refreshCookieOf = (response: request.Response): string => {
    const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
    return (raw ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
  };

  const sessionFrom = (response: request.Response): Session => {
    const accessToken = response.body.data.accessToken as string;
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString()) as { sid: string };
    return { accessToken, refreshCookie: refreshCookieOf(response), sessionId: payload.sid };
  };

  const login = (user: TestUser) => post('/auth/login').send({ username: user.username, password: PASSWORD });

  /** Login con contraseña de un usuario sin MFA: sesión NO verificada con segundo factor. */
  const passwordSession = async (user: TestUser): Promise<Session> => {
    const response = await login(user);
    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTruthy();
    return sessionFrom(response);
  };

  const mfaSession = async (user: TestUser, secret: string): Promise<Session> => {
    const challenge = await login(user);
    expect(challenge.body.data).toMatchObject({ requiresMfa: true });
    const verified = await post('/auth/mfa/verify', challenge.body.data.mfaChallengeToken as string).send({
      code: await totp(secret),
    });
    expect(verified.status).toBe(200);
    return sessionFrom(verified);
  };

  /** Sesión solo-contraseña de un usuario con MFA (p. ej. abierta antes de esta versión): mfa_verified_at NULL. */
  const legacySession = async (user: TestUser): Promise<Session> => {
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at) VALUES ($1, $2, $3, NOW() + interval '1 day')`,
      [sessionId, user.id, randomUUID()],
    );
    const roles = (await dataSource.query(
      `SELECT r.code FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1 AND ur.revoked_at IS NULL`,
      [user.id],
    )) as Array<{ code: string }>;
    const accessToken = tokens.signAccessToken({
      id: user.id,
      personId: user.personId,
      username: user.username,
      roles: roles.map((row) => row.code),
      scopes: [{ type: 'GLOBAL', id: null }],
      mustChangePassword: false,
      sessionId,
    });
    return { accessToken, refreshCookie: '', sessionId };
  };

  const remember = (...values: ReadonlyArray<string>): void => {
    for (const value of values) {
      secretsSeen.add(value);
      secretsSeen.add(value.replace(/-/g, ''));
    }
  };

  /** Enrola desde una sesión sin MFA y devuelve el secreto vigente y los códigos. */
  const enrollFromSession = async (session: Session): Promise<{ secret: string; codes: string[] }> => {
    const started = await post('/auth/me/mfa/enrollment', session.accessToken).send({});
    expect(started.status).toBe(200);
    const secret = started.body.data.secret as string;
    remember(secret);
    const confirmed = await post('/auth/me/mfa/enrollment/confirm', session.accessToken).send({ code: await totp(secret) });
    expect(confirmed.status).toBe(200);
    const codes = confirmed.body.data.recoveryCodes as string[];
    remember(...codes);
    return { secret, codes };
  };

  const dbUser = async (userId: string) => {
    const [row] = (await dataSource.query(
      `SELECT mfa_enabled, mfa_secret, mfa_pending_secret, mfa_enrollment_required,
              (SELECT count(*)::int FROM mfa_recovery_code c WHERE c.user_id = u.id AND c.used_at IS NULL) AS unused,
              (SELECT count(*)::int FROM mfa_recovery_code c WHERE c.user_id = u.id) AS total,
              (SELECT count(*)::int FROM refresh_token_family f WHERE f.user_id = u.id AND f.status = 'ACTIVE') AS active_sessions
       FROM app_user u WHERE u.id = $1`,
      [userId],
    )) as Array<{
      mfa_enabled: boolean;
      mfa_secret: string | null;
      mfa_pending_secret: string | null;
      mfa_enrollment_required: boolean;
      unused: number;
      total: number;
      active_sessions: number;
    }>;
    if (!row) {
      throw new Error('usuario inexistente');
    }
    return row;
  };

  const recoveryLogin = async (user: TestUser, code: string) => {
    const challenge = await login(user);
    expect(challenge.body.data).toMatchObject({ requiresMfa: true });
    return post('/auth/mfa/recovery', challenge.body.data.mfaChallengeToken as string).send({ recoveryCode: code });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    tokens = app.get(TokenService);
    hashes = app.get(HashService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('enrola desde una sesión normal: 10 códigos una sola vez, solo hasheados, y la sesión queda con MFA', async () => {
    const user = await createUser('VIEWER');
    const session = await passwordSession(user);

    const before = await get('/auth/me', session.accessToken);
    expect(before.body.data).toMatchObject({
      mfaEnabled: false,
      recoveryCodesRemaining: 0,
      mfaRequiredByRole: false,
      mfaSessionVerified: false,
    });

    const started = await post('/auth/me/mfa/enrollment', session.accessToken).send({});
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      secret: expect.any(String),
      otpauthUrl: expect.stringMatching(/^otpauth:\/\/totp\//),
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      expiresAt: expect.any(String),
    });
    const secret = started.body.data.secret as string;
    remember(secret);

    const wrong = await post('/auth/me/mfa/enrollment/confirm', session.accessToken).send({ code: await wrongTotp(secret) });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('MFA_VERIFICATION_FAILED');
    expect((await dbUser(user.id)).mfa_enabled).toBe(false);

    const confirmed = await post('/auth/me/mfa/enrollment/confirm', session.accessToken).send({ code: await totp(secret) });
    expect(confirmed.status).toBe(200);
    const codes = confirmed.body.data.recoveryCodes as string[];
    remember(...codes);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(confirmed.body.data.recoveryCodesRemaining).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }

    const row = await dbUser(user.id);
    expect(row).toMatchObject({ mfa_enabled: true, mfa_secret: secret, mfa_pending_secret: null, unused: 10 });
    const stored = (await dataSource.query('SELECT code_hash FROM mfa_recovery_code WHERE user_id = $1', [user.id])) as Array<{
      code_hash: string;
    }>;
    for (const { code_hash } of stored) {
      expect(code_hash).toMatch(/^\$argon2id\$/);
      for (const code of codes) {
        expect(code_hash).not.toContain(code.replace(/-/g, ''));
      }
    }

    const after = await get('/auth/me', session.accessToken);
    expect(after.body.data).toMatchObject({ mfaEnabled: true, recoveryCodesRemaining: 10, mfaSessionVerified: true });
    expect(JSON.stringify(after.body.data)).not.toContain(secret);
  });

  it('re-enrolar exige el factor actual; el secreto pendiente no reemplaza al vigente hasta confirmarse', async () => {
    const user = await createUser('VIEWER');
    const first = await enrollFromSession(await passwordSession(user));
    const session = await mfaSession(user, first.secret);
    const otherSession = await mfaSession(user, first.secret);

    const noProof = await post('/auth/me/mfa/enrollment', session.accessToken).send({});
    expect(noProof.status).toBe(403);
    expect(noProof.body.error.code).toBe('MFA_VERIFICATION_FAILED');
    const badProof = await post('/auth/me/mfa/enrollment', session.accessToken).send({ code: await wrongTotp(first.secret) });
    expect(badProof.status).toBe(403);

    const started = await post('/auth/me/mfa/enrollment', session.accessToken).send({ code: await totp(first.secret) });
    expect(started.status).toBe(200);
    const pending = started.body.data.secret as string;
    remember(pending);
    expect(pending).not.toBe(first.secret);

    // Sin confirmar: el vigente sigue siendo el único válido para iniciar sesión.
    const pendingRow = await dbUser(user.id);
    expect(pendingRow).toMatchObject({ mfa_secret: first.secret, mfa_pending_secret: pending, unused: 10 });
    const challenge = await login(user);
    const withPending = await post('/auth/mfa/verify', challenge.body.data.mfaChallengeToken as string).send({
      code: await totp(pending),
    });
    if (withPending.status === 200) {
      // Colisión de 1 en 10^6 entre los dos TOTP del mismo paso: el test no concluye nada en ese caso.
      expect(await totp(pending)).toBe(await totp(first.secret));
    } else {
      expect(withPending.status).toBe(401);
      expect(withPending.body.error.code).toBe('MFA_CODE_INVALID');
    }
    await mfaSession(user, first.secret);

    const confirmed = await post('/auth/me/mfa/enrollment/confirm', session.accessToken).send({ code: await totp(pending) });
    expect(confirmed.status).toBe(200);
    const newCodes = confirmed.body.data.recoveryCodes as string[];
    remember(...newCodes);

    const row = await dbUser(user.id);
    expect(row).toMatchObject({ mfa_secret: pending, mfa_pending_secret: null, unused: 10, total: 10, active_sessions: 1 });
    const otherStatus = (await scalar<string>(dataSource, 'SELECT status FROM refresh_token_family WHERE id = $1', [
      otherSession.sessionId,
    ])) as string;
    expect(otherStatus).toBe('REVOKED');
    // Los códigos del juego anterior ya no sirven.
    const oldCode = await recoveryLogin(user, first.codes[0] ?? '');
    expect(oldCode.status).toBe(401);

    const audit = (await dataSource.query(
      `SELECT action, changes FROM audit_log WHERE entity_id = $1 AND action IN ('MFA_ENROLL_START', 'MFA_REENROLLED') ORDER BY id`,
      [user.id],
    )) as Array<{ action: string; changes: Record<string, unknown> }>;
    expect(audit.at(-1)).toMatchObject({ action: 'MFA_REENROLLED', changes: { source: 'SESSION', recoveryCodesIssued: 10, revokedSessions: 3 } });
    expect(audit.some((entry) => entry.action === 'MFA_ENROLL_START' && entry.changes['proof'] === 'TOTP')).toBe(true);
  });

  it('re-enrola con un código de recuperación, que queda consumido', async () => {
    const user = await createUser('VIEWER');
    const session = await passwordSession(user);
    const first = await enrollFromSession(session);

    const started = await post('/auth/me/mfa/enrollment', session.accessToken).send({ recoveryCode: first.codes[3] });
    expect(started.status).toBe(200);
    remember(started.body.data.secret as string);
    expect((await dbUser(user.id)).unused).toBe(9);

    const reused = await post('/auth/me/mfa/enrollment', session.accessToken).send({ recoveryCode: first.codes[3] });
    expect(reused.status).toBe(403);
    expect(reused.body.error.code).toBe('MFA_VERIFICATION_FAILED');

    const confirmed = await post('/auth/me/mfa/enrollment/confirm', session.accessToken).send({
      code: await totp(started.body.data.secret as string),
    });
    expect(confirmed.status).toBe(200);
    remember(...(confirmed.body.data.recoveryCodes as string[]));
    expect((await dbUser(user.id)).unused).toBe(10);
  });

  it('inicia sesión con un código de recuperación: se consume y no se reutiliza', async () => {
    const user = await createUser('VIEWER');
    const { codes } = await enrollFromSession(await passwordSession(user));

    const first = await recoveryLogin(user, codes[0] ?? '');
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toBeTruthy();
    expect(first.body.data.recoveryCodesRemaining).toBe(9);
    const session = sessionFrom(first);
    const me = await get('/auth/me', session.accessToken);
    expect(me.body.data).toMatchObject({ recoveryCodesRemaining: 9, mfaSessionVerified: true });

    const again = await recoveryLogin(user, codes[0] ?? '');
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('MFA_CODE_INVALID');

    // Se acepta en minúsculas y con espacios en vez de guiones.
    const relaxed = await recoveryLogin(user, (codes[1] ?? '').toLowerCase().replace(/-/g, ' '));
    expect(relaxed.status).toBe(200);
    expect(relaxed.body.data.recoveryCodesRemaining).toBe(8);

    const used = (await dataSource.query(
      `SELECT changes FROM audit_log WHERE entity_id = $1 AND action = 'MFA_RECOVERY_USED' ORDER BY id`,
      [user.id],
    )) as Array<{ changes: Record<string, unknown> }>;
    expect(used.map((entry) => entry.changes)).toEqual([
      { purpose: 'LOGIN', recoveryCodesRemaining: 9 },
      { purpose: 'LOGIN', recoveryCodesRemaining: 8 },
    ]);
    const failed = await scalar<number>(
      dataSource,
      `SELECT count(*)::int FROM audit_log WHERE entity_id = $1 AND action = 'LOGIN_FAILED' AND changes->>'reason' = 'MFA_RECOVERY_CODE_INVALID'`,
      [user.id],
    );
    expect(failed).toBe(1);
  });

  it('el paso de recuperación tiene rate limit por IP', async () => {
    const user = await createUser('VIEWER');
    await enrollFromSession(await passwordSession(user));
    const ip = '192.0.2.77';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const challenge = await login(user);
      const response = await http()
        .post('/api/v1/auth/mfa/recovery')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${challenge.body.data.mfaChallengeToken as string}`)
        .send({ recoveryCode: 'ZZZZ-ZZZZ-ZZZZ' });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('regenerar códigos exige sesión con MFA e invalida el juego anterior', async () => {
    const user = await createUser('VIEWER');
    const { secret, codes } = await enrollFromSession(await passwordSession(user));

    const legacy = await legacySession(user);
    const denied = await post('/auth/me/mfa/recovery-codes', legacy.accessToken).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('MFA_SESSION_REQUIRED');
    expect(denied.body.action).toBe('REAUTH');

    const session = await mfaSession(user, secret);
    const regenerated = await post('/auth/me/mfa/recovery-codes', session.accessToken).send({});
    expect(regenerated.status).toBe(200);
    const fresh = regenerated.body.data.recoveryCodes as string[];
    remember(...fresh);
    expect(fresh).toHaveLength(10);
    expect(fresh.some((code) => codes.includes(code))).toBe(false);
    expect(await dbUser(user.id)).toMatchObject({ unused: 10, total: 10 });

    expect((await recoveryLogin(user, codes[5] ?? '')).status).toBe(401);
    expect((await recoveryLogin(user, fresh[5] ?? '')).status).toBe(200);
  });

  it('un usuario sin rol que lo exija puede desactivar MFA con su código; un rol que lo exige no', async () => {
    const viewer = await createUser('VIEWER');
    const viewerSession = await passwordSession(viewer);
    const { secret } = await enrollFromSession(viewerSession);
    const noProof = await post('/auth/me/mfa/disable', viewerSession.accessToken).send({});
    expect(noProof.status).toBe(403);
    const disabled = await post('/auth/me/mfa/disable', viewerSession.accessToken).send({ code: await totp(secret) });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data).toEqual({ revokedSessions: 0, recoveryCodesDeleted: 10 });
    expect(await dbUser(viewer.id)).toMatchObject({ mfa_enabled: false, mfa_secret: null, total: 0 });

    // Director de Control Interno: enrolamiento obligatorio por el flujo de setup, que ahora también entrega códigos.
    const director = await createUser('INTERNAL_CONTROL_DIRECTOR');
    const loginResponse = await login(director);
    expect(loginResponse.body.data).toMatchObject({ requiresMfaSetup: true });
    const setupToken = loginResponse.body.data.mfaSetupToken as string;
    const setup = await post('/auth/mfa/setup', setupToken).send();
    expect(setup.status).toBe(200);
    const directorSecret = setup.body.data.secret as string;
    remember(directorSecret);
    const confirmed = await post('/auth/mfa/confirm', setupToken).send({ code: await totp(directorSecret) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.accessToken).toBeTruthy();
    expect(confirmed.body.data.recoveryCodes).toHaveLength(10);
    remember(...(confirmed.body.data.recoveryCodes as string[]));
    const directorSession = sessionFrom(confirmed);

    const me = await get('/auth/me', directorSession.accessToken);
    expect(me.body.data).toMatchObject({ mfaEnabled: true, mfaRequiredByRole: true, mfaSessionVerified: true, recoveryCodesRemaining: 10 });

    const refused = await post('/auth/me/mfa/disable', directorSession.accessToken).send({ code: await totp(directorSecret) });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('MFA_REQUIRED_BY_ROLE');
    expect(await dbUser(director.id)).toMatchObject({ mfa_enabled: true, mfa_secret: directorSecret, unused: 10 });
  });

  it('reset administrativo: exige MFA del admin, prohíbe el propio, revoca sesiones y obliga a enrolar', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const adminLogin = await login(admin);
    const adminSetupToken = adminLogin.body.data.mfaSetupToken as string;
    const adminSetup = await post('/auth/mfa/setup', adminSetupToken).send();
    const adminSecret = adminSetup.body.data.secret as string;
    remember(adminSecret);
    const adminConfirmed = await post('/auth/mfa/confirm', adminSetupToken).send({ code: await totp(adminSecret) });
    expect(adminConfirmed.status).toBe(200);
    remember(...(adminConfirmed.body.data.recoveryCodes as string[]));
    const adminSession = sessionFrom(adminConfirmed);

    const target = await createUser('VIEWER');
    const { secret: targetSecret } = await enrollFromSession(await passwordSession(target));
    const targetSession = await mfaSession(target, targetSecret);
    const pendingStart = await post('/auth/me/mfa/enrollment', targetSession.accessToken).send({ code: await totp(targetSecret) });
    remember(pendingStart.body.data.secret as string);
    expect((await dbUser(target.id)).active_sessions).toBe(2);

    const legacyAdmin = await legacySession(admin);
    const noMfa = await post(`/users/${target.id}/mfa/reset`, legacyAdmin.accessToken).send({ reason: RESET_REASON });
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.code).toBe('MFA_SESSION_REQUIRED');

    const self = await post(`/users/${admin.id}/mfa/reset`, adminSession.accessToken).send({ reason: RESET_REASON });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MFA_SELF_RESET_FORBIDDEN');

    const noReason = await post(`/users/${target.id}/mfa/reset`, adminSession.accessToken).send({});
    expect(noReason.status).toBe(400);
    const shortReason = await post(`/users/${target.id}/mfa/reset`, adminSession.accessToken).send({ reason: 'perdido' });
    expect(shortReason.status).toBe(400);

    const outsider = await createUser('VIEWER');
    const outsiderSession = await passwordSession(outsider);
    const forbidden = await post(`/users/${target.id}/mfa/reset`, outsiderSession.accessToken).send({ reason: RESET_REASON });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');

    const missing = await post(`/users/${randomUUID()}/mfa/reset`, adminSession.accessToken).send({ reason: RESET_REASON });
    expect(missing.status).toBe(404);

    expect(await dbUser(target.id)).toMatchObject({ mfa_enabled: true, unused: 10 });

    const reset = await post(`/users/${target.id}/mfa/reset`, adminSession.accessToken).send({ reason: RESET_REASON });
    expect(reset.status).toBe(200);
    expect(reset.body.data).toEqual({ userId: target.id, revokedSessions: 2, recoveryCodesDeleted: 10, mfaEnrollmentRequired: true });
    expect(await dbUser(target.id)).toMatchObject({
      mfa_enabled: false,
      mfa_secret: null,
      mfa_pending_secret: null,
      mfa_enrollment_required: true,
      total: 0,
      active_sessions: 0,
    });

    // La sesión del afectado ya no se puede renovar.
    const refresh = await http()
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', nextIp())
      .set('Cookie', targetSession.refreshCookie);
    expect(refresh.status).toBe(401);

    // Siguiente login: enrolamiento obligatorio aunque VIEWER no lo exija; al completarlo se limpia la marca.
    const relogin = await login(target);
    expect(relogin.body.data).toMatchObject({ requiresMfaSetup: true });
    const setupToken = relogin.body.data.mfaSetupToken as string;
    const setup = await post('/auth/mfa/setup', setupToken).send();
    remember(setup.body.data.secret as string);
    const reenrolled = await post('/auth/mfa/confirm', setupToken).send({ code: await totp(setup.body.data.secret as string) });
    expect(reenrolled.status).toBe(200);
    remember(...(reenrolled.body.data.recoveryCodes as string[]));
    expect(await dbUser(target.id)).toMatchObject({ mfa_enabled: true, mfa_enrollment_required: false, unused: 10 });

    const [entry] = (await dataSource.query(
      `SELECT entity_type, entity_id, performed_by, performed_at, changes FROM audit_log
       WHERE action = 'MFA_ADMIN_RESET' AND entity_id = $1`,
      [target.id],
    )) as Array<{ entity_type: string; entity_id: string; performed_by: string; performed_at: Date; changes: Record<string, unknown> }>;
    expect(entry).toMatchObject({
      entity_type: 'USER',
      entity_id: target.id,
      performed_by: admin.id,
      changes: { reason: RESET_REASON, hadMfa: true, recoveryCodesDeleted: 10, revokedSessions: 2 },
    });
    expect(entry?.performed_at).toBeInstanceOf(Date);
    expect(Object.keys(entry?.changes ?? {}).sort()).toEqual(['hadMfa', 'reason', 'recoveryCodesDeleted', 'revokedSessions']);
  });

  it('las respuestas reales de las rutas nuevas y cambiadas cumplen el esquema OpenAPI publicado', () => {
    const openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const seen = new Set(observed.map((entry) => `${entry.method} ${entry.route} ${entry.status}`));
    for (const route of CONTRACT_ROUTES) {
      expect([...seen].some((key) => key.includes(` ${route} 200`)), `${route} sin respuesta 200 observada`).toBe(true);
    }
    const errors: string[] = [];
    for (const entry of observed) {
      const operation = (openapi.paths[entry.route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[
        entry.method
      ];
      const schema = operation?.responses[String(entry.status)]?.content?.['application/json']?.schema;
      if (!schema) {
        errors.push(`${entry.method.toUpperCase()} ${entry.route} ${entry.status}: no declara esquema`);
        continue;
      }
      conform(openapi, entry.body, schema, `${entry.method.toUpperCase()} ${entry.route} ${entry.status}`, errors);
    }
    const foreign = errors.filter((error) => KNOWN_FOREIGN_MISMATCH.test(error));
    expect(foreign.length).toBeGreaterThan(0);
    expect([...new Set(errors.filter((error) => !KNOWN_FOREIGN_MISMATCH.test(error)))]).toEqual([]);
  });

  it('ningún secreto TOTP ni código de recuperación aparece en audit_log', async () => {
    expect(secretsSeen.size).toBeGreaterThan(50);
    const leaks = (await dataSource.query(
      `SELECT count(*)::int AS leaks FROM audit_log a, unnest($1::text[]) AS s
       WHERE a.changes::text ILIKE '%' || s || '%' OR a.user_agent ILIKE '%' || s || '%'`,
      [[...secretsSeen]],
    )) as Array<{ leaks: number }>;
    expect(leaks[0]?.leaks).toBe(0);
    const mfaRows = await scalar<number>(
      dataSource,
      `SELECT count(*)::int FROM audit_log WHERE action LIKE 'MFA%' OR (action = 'LOGIN' AND changes ? 'mfaMethod')`,
    );
    expect(mfaRows).toBeGreaterThan(10);
  });
});
