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
import { scalar, openTestSession, withGrantReason } from './helpers.js';

/**
 * BE-02 (herencia evade assertCanGrant y SoD) y BE-03 (permisos de roles borrados siguen vigentes), por HTTP real
 * contra PostgreSQL real. También cubre que la administración en cascada legítima siga funcionando.
 */
describe('Herencia de roles: privilegios, SoD y borrado (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let tokens: TokenService;
  let ipCounter = 0;

  interface TestUser {
    readonly id: string;
    readonly personId: string;
    readonly username: string;
    readonly token: string;
  }

  const roleId = (code: string): Promise<string> =>
    scalar<string>(dataSource, 'SELECT id FROM role WHERE code = $1', [code]);

  const tag = (): string => randomUUID().slice(0, 8).toUpperCase();

  const createUser = async (roleCodes: ReadonlyArray<string>): Promise<TestUser> => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Prueba', $1, $2) RETURNING id`,
      [`Roles ${suffix}`, `roles.${suffix}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `roles.${suffix}`],
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
      username: `roles.${suffix}`,
      roles: [...roleCodes],
      scopes: [{ type: 'GLOBAL', id: null }],
      mustChangePassword: false,
      sessionId: await openTestSession(dataSource, id),
    });
    return { id, personId, username: `roles.${suffix}`, token };
  };

  const call = (method: 'post' | 'patch' | 'delete' | 'get', path: string, token: string) => {
    ipCounter += 1;
    return withGrantReason(
      method,
      path,
      request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .set('X-Forwarded-For', `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`)
        .set('Authorization', `Bearer ${token}`),
    );
  };

  const permissionId = (code: string): Promise<string> =>
    scalar<string>(dataSource, 'SELECT id FROM permission WHERE code = $1', [code]);

  const effectivePermissions = async (userId: string): Promise<string[]> => {
    const rows = (await dataSource.query(
      'SELECT DISTINCT permission_code FROM v_user_effective_permissions WHERE user_id = $1 ORDER BY 1',
      [userId],
    )) as Array<{ permission_code: string }>;
    return rows.map((row) => row.permission_code);
  };

  /** Crea un rol por SQL (fuera de la API), como lo dejaría un dato heredado o un script. */
  const insertRole = async (code: string, level: number, parentCode: string | null): Promise<string> => {
    return scalar<string>(
      dataSource,
      `INSERT INTO role (code, name, hierarchy_level, parent_role_id, superior_role_id)
       VALUES ($1, $1, $2, (SELECT id FROM role WHERE code = $3), (SELECT id FROM role WHERE code = 'SUPER_ADMIN'))
       RETURNING id`,
      [code, level, parentCode],
    );
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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('BE-02: la herencia pasa por las mismas reglas que otorgar permisos', () => {
    it('SUPER_ADMIN no puede crear un rol que herede del Director (escenario del hallazgo)', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const response = await call('post', '/roles', admin.token).send({
        code: `SHADOW_${tag()}`,
        name: 'Rol sombra',
        parentRoleId: await roleId('INTERNAL_CONTROL_DIRECTOR'),
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_NOT_HELD');
    });

    it('SUPER_ADMIN no puede re-apuntar la herencia de un rol existente al Director', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const created = await call('post', '/roles', admin.token).send({ code: `EMPTY_${tag()}`, name: 'Vacío' });
      expect(created.status).toBe(201);
      const response = await call('patch', `/roles/${created.body.data.id as string}`, admin.token).send({
        parentRoleId: await roleId('INTERNAL_CONTROL_DIRECTOR'),
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_NOT_HELD');
      expect(
        await scalar<string | null>(dataSource, 'SELECT parent_role_id FROM role WHERE id = $1', [created.body.data.id]),
      ).toBeNull();
    });

    it('la BD rechaza asignar a un SUPER_ADMIN un rol que hereda del Director, aunque no sea el Director', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const shadowId = await insertRole(`SHADOW_SQL_${tag()}`, 2, 'INTERNAL_CONTROL_DIRECTOR');
      await expect(
        dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) VALUES ($1, $2, 'GLOBAL')`, [
          admin.id,
          shadowId,
        ]),
      ).rejects.toThrow(/Separación de Funciones/);

      const assigner = await createUser(['SUPER_ADMIN']);
      const response = await call('post', `/users/${admin.id}/roles`, assigner.token).send({
        roleId: shadowId,
        scopeType: 'GLOBAL',
      });
      expect(response.status).toBe(406);
      expect(response.body.error.code).toBe('SOD_VIOLATION');
      expect(await effectivePermissions(admin.id)).not.toContain('asset:write_off:global');
    });

    it('la BD rechaza cambiar la herencia de un rol ya asignado si deja a un titular en conflicto', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const plainId = await insertRole(`PLAIN_${tag()}`, 2, null);
      await dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) VALUES ($1, $2, 'GLOBAL')`, [
        admin.id,
        plainId,
      ]);
      await expect(
        dataSource.query(`UPDATE role SET parent_role_id = (SELECT id FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR') WHERE id = $1`, [
          plainId,
        ]),
      ).rejects.toThrow(/Separación de Funciones/);
      expect(await scalar<string | null>(dataSource, 'SELECT parent_role_id FROM role WHERE id = $1', [plainId])).toBeNull();
    });

    it('la API traduce a SOD_VIOLATION un cambio de herencia que el actor sí puede otorgar pero rompe una regla', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const createRole = async (permissionCode: string | null) => {
        const response = await call('post', '/roles', admin.token).send({
          code: `SOD_${tag()}`,
          name: 'Regla SoD',
          ...(permissionCode ? { permissionIds: [await permissionId(permissionCode)] } : {}),
        });
        expect(response.status).toBe(201);
        return response.body.data.id as string;
      };
      const roleA = await createRole('user:read:global');
      const roleB = await createRole('role:read:global');
      const roleC = await createRole(null);
      const rule = await call('post', '/roles/sod-rules', admin.token).send({
        roleAId: roleA,
        roleBId: roleB,
        constraintType: 'STATIC',
        reason: 'Prueba de integración BE-02',
      });
      expect(rule.status).toBe(201);

      const holder = await createUser([]);
      for (const id of [roleA, roleC]) {
        const assigned = await call('post', `/users/${holder.id}/roles`, admin.token).send({ roleId: id, scopeType: 'GLOBAL' });
        expect(assigned.status).toBe(201);
      }
      // C hereda de B: el titular de A quedaría con A y B (efectivo). La política deja pasar (el actor tiene
      // role:read:global); la regla la hace cumplir la BD y la API responde 406.
      const reparent = await call('patch', `/roles/${roleC}`, admin.token).send({ parentRoleId: roleB });
      expect(reparent.status).toBe(406);
      expect(reparent.body.error.code).toBe('SOD_VIOLATION');

      // Y al revés: con C → B ya vigente para otro usuario, asignarle A también viola la regla por herencia.
      const other = await createUser([]);
      const roleD = await createRole(null);
      const linked = await call('patch', `/roles/${roleD}`, admin.token).send({ parentRoleId: roleB });
      expect(linked.status).toBe(200);
      expect((await call('post', `/users/${other.id}/roles`, admin.token).send({ roleId: roleD, scopeType: 'GLOBAL' })).status).toBe(201);
      const conflicting = await call('post', `/users/${other.id}/roles`, admin.token).send({ roleId: roleA, scopeType: 'GLOBAL' });
      expect(conflicting.status).toBe(406);
      expect(conflicting.body.error.code).toBe('SOD_VIOLATION');
    });

    describe('cascada legítima: el Director crea un rol "asistente"', () => {
      beforeAll(async () => {
        // En la semilla solo SUPER_ADMIN crea roles; se concede al Director para probar la cascada y se retira después.
        await dataSource.query(
          `INSERT INTO role_permission (role_id, permission_id)
           SELECT r.id, p.id FROM role r, permission p
           WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR' AND p.code = 'role:create:global'
           ON CONFLICT DO NOTHING`,
        );
      });

      afterAll(async () => {
        await dataSource.query(
          `DELETE FROM role_permission
           WHERE role_id = (SELECT id FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR')
             AND permission_id = (SELECT id FROM permission WHERE code = 'role:create:global')`,
        );
      });

      it('con permisos y herencia que el Director tiene: 201, un nivel por debajo del Director', async () => {
        const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
        const code = `ASSISTANT_${tag()}`;
        const response = await call('post', '/roles', director.token).send({
          code,
          name: 'Asistente de control interno',
          parentRoleId: await roleId('AUDITOR'),
          permissionIds: [await permissionId('asset:create:global'), await permissionId('inventory:execute:global')],
        });
        expect(response.status).toBe(201);
        expect(response.body.data).toMatchObject({
          code,
          hierarchyLevel: 2,
          superiorRoleId: await roleId('INTERNAL_CONTROL_DIRECTOR'),
          parentRoleId: await roleId('AUDITOR'),
        });
      });

      it('no puede heredar de un rol de su nivel o superior', async () => {
        const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
        const response = await call('post', '/roles', director.token).send({
          code: `UP_${tag()}`,
          name: 'Hacia arriba',
          parentRoleId: await roleId('SUPER_ADMIN'),
        });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('ROLE_PRIVILEGE_ESCALATION');
      });

      it('no puede otorgar un permiso que no tiene', async () => {
        const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
        const response = await call('post', '/roles', director.token).send({
          code: `GRAB_${tag()}`,
          name: 'Acaparador',
          permissionIds: [await permissionId('user:manage:global')],
        });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_NOT_HELD');
      });
    });
  });

  describe('BE-03: un rol borrado no aporta permisos', () => {
    const scenario = async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const parent = await call('post', '/roles', admin.token).send({
        code: `COORD_${tag()}`,
        name: 'Coordinador',
        permissionIds: [await permissionId('user:read:global')],
      });
      expect(parent.status).toBe(201);
      const child = await call('post', '/roles', admin.token).send({
        code: `AUX_${tag()}`,
        name: 'Auxiliar',
        parentRoleId: parent.body.data.id,
      });
      expect(child.status).toBe(201);
      const holder = await createUser([]);
      const assigned = await call('post', `/users/${holder.id}/roles`, admin.token).send({
        roleId: child.body.data.id,
        scopeType: 'GLOBAL',
      });
      expect(assigned.status).toBe(201);
      expect(await effectivePermissions(holder.id)).toContain('user:read:global');
      return { admin, holder, parentId: parent.body.data.id as string, childId: child.body.data.id as string };
    };

    it('no se borra un rol del que otros heredan (409 de negocio: 406 ROLE_HAS_CHILD_ROLES)', async () => {
      const { admin, holder, parentId } = await scenario();
      const response = await call('delete', `/roles/${parentId}`, admin.token);
      expect(response.status).toBe(406);
      expect(response.body.error.code).toBe('ROLE_HAS_CHILD_ROLES');
      expect(await scalar<Date | null>(dataSource, 'SELECT deleted_at FROM role WHERE id = $1', [parentId])).toBeNull();
      expect(await effectivePermissions(holder.id)).toContain('user:read:global');
    });

    it('tras desenlazar al hijo, el padre se borra y el titular pierde el permiso (vista y /auth/me)', async () => {
      const { admin, holder, parentId, childId } = await scenario();
      const unlinked = await call('patch', `/roles/${childId}`, admin.token).send({ parentRoleId: null });
      expect(unlinked.status).toBe(200);
      expect(await effectivePermissions(holder.id)).not.toContain('user:read:global');
      const removed = await call('delete', `/roles/${parentId}`, admin.token);
      expect(removed.status).toBe(200);
      const me = await call('get', '/auth/me', tokens.signAccessToken({
        id: holder.id,
        personId: holder.personId,
        username: holder.username,
        roles: [],
        scopes: [{ type: 'GLOBAL', id: null }],
        mustChangePassword: false,
        sessionId: await openTestSession(dataSource, holder.id),
      }));
      expect(me.status).toBe(200);
      expect(me.body.data.permissions).not.toContain('user:read:global');
    });

    it('un padre ya borrado (dato previo a la corrección) deja de aportar permisos a sus hijos', async () => {
      const { holder, parentId } = await scenario();
      await dataSource.query('UPDATE role SET deleted_at = NOW() WHERE id = $1', [parentId]);
      expect(await effectivePermissions(holder.id)).not.toContain('user:read:global');
    });

    it('un rol borrado asignado directamente tampoco aporta permisos', async () => {
      const holder = await createUser([]);
      const directId = await insertRole(`DIRECT_${tag()}`, 3, null);
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = 'user:read:global'`,
        [directId],
      );
      await dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) VALUES ($1, $2, 'GLOBAL')`, [holder.id, directId]);
      expect(await effectivePermissions(holder.id)).toContain('user:read:global');
      await dataSource.query('UPDATE role SET deleted_at = NOW() WHERE id = $1', [directId]);
      expect(await effectivePermissions(holder.id)).toEqual([]);
    });
  });
});
