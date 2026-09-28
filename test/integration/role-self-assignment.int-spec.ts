import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { GRANT_REASON, scalar, openTestSession, withGrantReason } from './helpers.js';

/** Regla del desarrollador: nadie se autoasigna roles ni permisos, tampoco SUPER_ADMIN (HTTP real + PostgreSQL real). */
describe('Autoasignación de roles prohibida (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let tokens: TokenService;
  let ipCounter = 0;

  interface TestUser {
    readonly id: string;
    readonly token: string;
  }

  const createUser = async (roleCodes: ReadonlyArray<string>): Promise<TestUser> => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Prueba', $1, $2) RETURNING id`,
      [`Auto ${suffix}`, `auto.${suffix}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `auto.${suffix}`],
    );
    for (const code of roleCodes) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [id, code],
      );
    }
    const token = tokens.signAccessToken({
      id,
      personId,
      username: `auto.${suffix}`,
      roles: [...roleCodes],
      scopes: [{ type: 'GLOBAL', id: null }],
      mustChangePassword: false,
      sessionId: await openTestSession(dataSource, id),
    });
    return { id, token };
  };

  const post = (path: string, token: string) => {
    ipCounter += 1;
    return withGrantReason(
      'post',
      path,
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Forwarded-For', `198.19.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`)
        .set('Authorization', `Bearer ${token}`),
    );
  };

  const roleId = (code: string): Promise<string> =>
    scalar<string>(dataSource, 'SELECT id FROM role WHERE code = $1', [code]);

  const assignmentOf = (userId: string, code: string): Promise<string> =>
    scalar<string>(
      dataSource,
      `SELECT ur.id FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.code = $2 AND ur.revoked_at IS NULL`,
      [userId, code],
    );

  const activeRoleCount = (userId: string): Promise<number> =>
    scalar<number>(dataSource, 'SELECT count(*)::int FROM user_role WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('SUPER_ADMIN', () => {
    it('no puede asignarse ningún rol, ni uno de sistema ni uno que acaba de crear', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const before = await activeRoleCount(admin.id);
      const viewer = await post(`/users/${admin.id}/roles`, admin.token).send({ roleId: await roleId('VIEWER'), scopeType: 'GLOBAL' });
      expect(viewer.status).toBe(403);
      expect(viewer.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');

      const created = await post('/roles', admin.token).send({
        code: `SELF_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Rol propio',
      });
      expect(created.status).toBe(201);
      const own = await post(`/users/${admin.id}/roles`, admin.token).send({ roleId: created.body.data.id, scopeType: 'GLOBAL' });
      expect(own.status).toBe(403);
      expect(own.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
      expect(await activeRoleCount(admin.id)).toBe(before);
    });

    it('no puede delegarse el rol de otro usuario', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const holder = await createUser(['VIEWER']);
      const response = await post(`/users/${holder.id}/roles/${await assignmentOf(holder.id, 'VIEWER')}/delegate`, admin.token).send({
        toUserId: admin.id,
        validUntil: tomorrow(),
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
      expect(await activeRoleCount(admin.id)).toBe(1);
    });

    it('asignar y delegar a otro sigue funcionando', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const other = await createUser([]);
      const assigned = await post(`/users/${other.id}/roles`, admin.token).send({ roleId: await roleId('VIEWER'), scopeType: 'GLOBAL' });
      expect(assigned.status).toBe(201);
      const target = await createUser([]);
      const delegated = await post(`/users/${other.id}/roles/${await assignmentOf(other.id, 'VIEWER')}/delegate`, admin.token).send({
        toUserId: target.id,
        validUntil: tomorrow(),
      });
      expect(delegated.status).toBe(201);
    });

    it('sí puede revocarse un rol propio (solo reduce privilegios)', async () => {
      const admin = await createUser(['SUPER_ADMIN', 'VIEWER']);
      const response = await request(app.getHttpServer())
        .delete(`/api/v1/users/${admin.id}/roles/${await assignmentOf(admin.id, 'VIEWER')}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ reason: GRANT_REASON });
      expect(response.status).toBe(200);
      expect(await activeRoleCount(admin.id)).toBe(1);
    });
  });

  describe('Director de Control Interno', () => {
    beforeAll(async () => {
      // En la semilla el Director no asigna roles; se le concede para probar que tampoco puede autoasignarse.
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id FROM role r, permission p
         WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR' AND p.code = 'role:assign:global'
         ON CONFLICT DO NOTHING`,
      );
    });

    afterAll(async () => {
      await dataSource.query(
        `DELETE FROM role_permission
         WHERE role_id = (SELECT id FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR')
           AND permission_id = (SELECT id FROM permission WHERE code = 'role:assign:global')`,
      );
    });

    it('no puede asignarse un rol ni delegárselo', async () => {
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const assigned = await post(`/users/${director.id}/roles`, director.token).send({ roleId: await roleId('AUDITOR'), scopeType: 'GLOBAL' });
      expect(assigned.status).toBe(403);
      expect(assigned.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');

      const holder = await createUser(['AUDITOR']);
      const delegated = await post(`/users/${holder.id}/roles/${await assignmentOf(holder.id, 'AUDITOR')}/delegate`, director.token).send({
        toUserId: director.id,
        validUntil: tomorrow(),
      });
      expect(delegated.status).toBe(403);
      expect(delegated.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
      expect(await activeRoleCount(director.id)).toBe(1);
    });

    it('asignar un rol inferior a otro sigue funcionando', async () => {
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const other = await createUser([]);
      const assigned = await post(`/users/${other.id}/roles`, director.token).send({ roleId: await roleId('AUDITOR'), scopeType: 'GLOBAL' });
      expect(assigned.status).toBe(201);
    });
  });

  describe('permisos de un rol propio', () => {
    it('agregar a un rol propio un permiso, aunque el actor ya lo tenga con el mismo alcance, está prohibido (lo hace otro): 403', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const ownRole = await scalar<string>(
        dataSource,
        `INSERT INTO role (code, name, hierarchy_level) VALUES ($1, 'Propio', 3) RETURNING id`,
        [`OWN_${randomUUID().slice(0, 8).toUpperCase()}`],
      );
      await dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) VALUES ($1, $2, 'GLOBAL')`, [admin.id, ownRole]);
      const permission = await scalar<string>(dataSource, `SELECT id FROM permission WHERE code = 'user:read:global'`);
      const response = await post(`/roles/${ownRole}/permissions`, admin.token).send({ permissionIds: [permission] });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });

    it('agregarlo cuando el actor solo lo tiene en un alcance menor lo ampliaría: 403', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const unit = randomUUID(); // scope_id es polimórfico (sin FK): basta un id de unidad
      // El actor tiene asset:read:org_unit solo con alcance ORG_UNIT (VIEWER en su unidad)...
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'ORG_UNIT', $2 FROM role WHERE code = 'VIEWER'`,
        [admin.id, unit],
      );
      // ...y un rol propio con alcance GLOBAL: agregarle ese permiso se lo daría en todo el sistema.
      const ownRole = await scalar<string>(
        dataSource,
        `INSERT INTO role (code, name, hierarchy_level) VALUES ($1, 'Propio global', 3) RETURNING id`,
        [`WIDE_${randomUUID().slice(0, 8).toUpperCase()}`],
      );
      await dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) VALUES ($1, $2, 'GLOBAL')`, [admin.id, ownRole]);
      const permission = await scalar<string>(dataSource, `SELECT id FROM permission WHERE code = 'asset:read:org_unit'`);
      const response = await post(`/roles/${ownRole}/permissions`, admin.token).send({ permissionIds: [permission] });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });
  });
});
