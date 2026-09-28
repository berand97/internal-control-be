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
import { GRANT_REASON, openTestSession, scalar, withGrantReason } from './helpers.js';

/**
 * Cascada de permisos (decisión del desarrollador, ronda 5): SUPER_ADMIN otorga cualquier permiso a cualquier rol
 * aunque no lo tenga; los demás solo lo que tienen y a roles inferiores; nadie se autoasigna (tampoco por caminos
 * indirectos: rol propio vigente o futuro, con alcance COST_CENTER o heredado); cada otorgamiento queda auditado con
 * motivo, IP y user-agent y la Directora lo consulta en GET /roles/grants-history. HTTP real + PostgreSQL real.
 */
describe('Cascada de permisos, autoescalamiento e historial de otorgamientos (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let tokens: TokenService;
  let ipCounter = 0;
  const USER_AGENT = 'it-grants/1.0';

  interface TestUser {
    readonly id: string;
    readonly token: string;
  }

  interface Assignment {
    readonly code: string;
    readonly scopeType?: 'GLOBAL' | 'COST_CENTER';
    readonly scopeId?: string | null;
    readonly validFrom?: string;
  }

  const createUser = async (assignments: ReadonlyArray<string | Assignment>): Promise<TestUser> => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Cascada', $1, $2) RETURNING id`,
      [suffix, `cascada.${suffix}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `cascada.${suffix}`],
    );
    for (const item of assignments) {
      const assignment = typeof item === 'string' ? { code: item } : item;
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id, valid_from)
         SELECT $1, id, $2, $3, coalesce($4::timestamptz, NOW()) FROM role WHERE code = $5`,
        [id, assignment.scopeType ?? 'GLOBAL', assignment.scopeId ?? null, assignment.validFrom ?? null, assignment.code],
      );
    }
    const token = tokens.signAccessToken({
      id,
      personId,
      username: `cascada.${suffix}`,
      roles: assignments.map((item) => (typeof item === 'string' ? item : item.code)),
      scopes: [{ type: 'GLOBAL', id: null }],
      mustChangePassword: false,
      sessionId: await openTestSession(dataSource, id),
    });
    return { id, token };
  };

  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token: string, reason = true) => {
    ipCounter += 1;
    const pending = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Forwarded-For', `198.20.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`)
      .set('User-Agent', USER_AGENT)
      .set('Authorization', `Bearer ${token}`);
    return reason ? withGrantReason(method, path, pending) : pending;
  };

  const roleId = (code: string): Promise<string> => scalar<string>(dataSource, 'SELECT id FROM role WHERE code = $1', [code]);
  const permissionId = (code: string): Promise<string> =>
    scalar<string>(dataSource, 'SELECT id FROM permission WHERE code = $1', [code]);
  const roleHas = (role: string, permission: string): Promise<boolean> =>
    scalar<boolean>(
      dataSource,
      `SELECT EXISTS (SELECT 1 FROM role_permission rp JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
                      WHERE r.code = $1 AND p.code = $2)`,
      [role, permission],
    );
  const grantSql = (role: string, permission: string) =>
    dataSource.query(
      `INSERT INTO role_permission (role_id, permission_id) SELECT r.id, p.id FROM role r, permission p
       WHERE r.code = $1 AND p.code = $2 ON CONFLICT DO NOTHING`,
      [role, permission],
    );
  const revokeSql = (role: string, permission: string) =>
    dataSource.query(
      `DELETE FROM role_permission WHERE role_id = (SELECT id FROM role WHERE code = $1)
         AND permission_id = (SELECT id FROM permission WHERE code = $2)`,
      [role, permission],
    );
  const insertRole = (prefix: string, level: number, parentCode: string | null = null): Promise<string> =>
    scalar<string>(
      dataSource,
      `INSERT INTO role (code, name, hierarchy_level, parent_role_id)
       VALUES ($1, 'Rol de prueba', $2, (SELECT id FROM role WHERE code = $3)) RETURNING id`,
      [`${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`, level, parentCode],
    );
  const codeOf = (id: string): Promise<string> => scalar<string>(dataSource, 'SELECT code FROM role WHERE id = $1', [id]);

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

  describe('SUPER_ADMIN: administración pura', () => {
    it('quita a la Directora cost_center:manage:global y se lo devuelve aunque no lo tenga (el callejón sin salida se cierra)', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const director = await roleId('INTERNAL_CONTROL_DIRECTOR');
      const manage = await permissionId('cost_center:manage:global');
      await grantSql('INTERNAL_CONTROL_DIRECTOR', 'cost_center:manage:global');
      try {
        const removed = await call('delete', `/roles/${director}/permissions/${manage}`, admin.token);
        expect(removed.status).toBe(200);
        expect(await roleHas('INTERNAL_CONTROL_DIRECTOR', 'cost_center:manage:global')).toBe(false);

        const restored = await call('post', `/roles/${director}/permissions`, admin.token).send({ permissionIds: [manage] });
        expect(restored.status).toBe(201);
        expect(await roleHas('INTERNAL_CONTROL_DIRECTOR', 'cost_center:manage:global')).toBe(true);

        // Otorga, no opera: el SUPER_ADMIN sigue sin el permiso operativo.
        const own = (await dataSource.query(
          `SELECT DISTINCT permission_code FROM v_user_effective_permissions WHERE user_id = $1`,
          [admin.id],
        )) as Array<{ permission_code: string }>;
        expect(own.map((row) => row.permission_code)).not.toContain('cost_center:manage:global');

        const audits = (await dataSource.query(
          `SELECT ip_address::text AS ip, user_agent, performed_by, changes FROM audit_log
           WHERE action = 'ROLE_PERMS_SET' AND entity_id = $1 AND performed_by = $2 ORDER BY id`,
          [director, admin.id],
        )) as Array<{ ip: string | null; user_agent: string | null; changes: Record<string, unknown> }>;
        expect(audits).toHaveLength(2);
        expect(audits[0]?.changes).toMatchObject({
          removedPermissionCodes: ['cost_center:manage:global'],
          addedPermissionCodes: [],
          reason: GRANT_REASON,
          roleCode: 'INTERNAL_CONTROL_DIRECTOR',
        });
        expect(audits[1]?.changes).toMatchObject({
          addedPermissionIds: [manage],
          addedPermissionCodes: ['cost_center:manage:global'],
          removedPermissionCodes: [],
          reason: GRANT_REASON,
        });
        for (const row of audits) {
          expect(row.ip).toMatch(/^198\.20\./);
          expect(row.user_agent).toBe(USER_AGENT);
        }
      } finally {
        await grantSql('INTERNAL_CONTROL_DIRECTOR', 'cost_center:manage:global');
      }
    });

    it('crea un rol con permisos operativos que no tiene y lo asigna a otro, nunca a sí mismo', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const created = await call('post', '/roles', admin.token).send({
        code: `SA_GRANT_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Rol operativo',
        permissionIds: [await permissionId('inventory:create:global')],
      });
      expect(created.status).toBe(201);
      const other = await createUser([]);
      expect((await call('post', `/users/${other.id}/roles`, admin.token).send({ roleId: created.body.data.id })).status).toBe(201);
      const self = await call('post', `/users/${admin.id}/roles`, admin.token).send({ roleId: created.body.data.id });
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });

    it('no edita permisos del propio SUPER_ADMIN (rango igual)', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const response = await call('post', `/roles/${await roleId('SUPER_ADMIN')}/permissions`, admin.token).send({
        permissionIds: [await permissionId('asset:read:global')],
      });
      expect(response.status).toBe(403);
      expect(await roleHas('SUPER_ADMIN', 'asset:read:global')).toBe(false);
    });
  });

  describe('Directora: cascada normal', () => {
    beforeAll(async () => {
      // En la semilla la Directora no administra roles; se le concede para probar la cascada y se retira después.
      for (const code of ['role:manage:global', 'role:create:global', 'role:assign:global']) {
        await grantSql('INTERNAL_CONTROL_DIRECTOR', code);
      }
    });

    afterAll(async () => {
      for (const code of ['role:manage:global', 'role:create:global', 'role:assign:global']) {
        await revokeSql('INTERNAL_CONTROL_DIRECTOR', code);
      }
      await revokeSql('DEPARTMENT_HEAD', 'inventory:create:global');
    });

    it('no fabrica permisos que no tiene: 403 PERMISSION_NOT_HELD', async () => {
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const response = await call('post', `/roles/${await roleId('AUDITOR')}/permissions`, director.token).send({
        permissionIds: [await permissionId('user:read:global')],
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_NOT_HELD');
      expect(await roleHas('AUDITOR', 'user:read:global')).toBe(false);
    });

    it('otorga lo que tiene a un rol inferior, no a su propio nivel ni a uno del que hereda', async () => {
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const granted = await call('post', `/roles/${await roleId('DEPARTMENT_HEAD')}/permissions`, director.token).send({
        permissionIds: [await permissionId('inventory:create:global')],
      });
      expect(granted.status).toBe(201);
      expect(await roleHas('DEPARTMENT_HEAD', 'inventory:create:global')).toBe(true);

      // INTERNAL_CONTROL_DIRECTOR hereda de AUDITOR (semilla): lo que se agregue a AUDITOR le llega a ella misma.
      const inherited = await call('post', `/roles/${await roleId('AUDITOR')}/permissions`, director.token).send({
        permissionIds: [await permissionId('inventory:create:global')],
      });
      expect(inherited.status).toBe(403);
      expect(inherited.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
      expect(await roleHas('AUDITOR', 'inventory:create:global')).toBe(false);

      const own = await call('post', `/roles/${await roleId('INTERNAL_CONTROL_DIRECTOR')}/permissions`, director.token).send({
        permissionIds: [await permissionId('inventory:create:global')],
      });
      expect(own.status).toBe(403);
      expect(own.body.error.code).toBe('ROLE_PRIVILEGE_ESCALATION');
    });

    it('crea un rol con lo que tiene pero no se lo asigna, ni uno creado por otro con más permisos', async () => {
      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const created = await call('post', '/roles', director.token).send({
        code: `DIR_ASSIST_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Asistente',
        permissionIds: [await permissionId('inventory:create:global')],
      });
      expect(created.status).toBe(201);
      const self = await call('post', `/users/${director.id}/roles`, director.token).send({ roleId: created.body.data.id });
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');

      const richer = await insertRole('RICHER', 3);
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = 'user:read:global'`,
        [richer],
      );
      const other = await call('post', `/users/${director.id}/roles`, director.token).send({ roleId: richer });
      expect(other.status).toBe(403);
      expect(other.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });
  });

  describe('caminos indirectos de autoescalamiento (cerrados)', () => {
    const addTo = async (actor: TestUser, role: string, permission: string) =>
      call('post', `/roles/${role}/permissions`, actor.token).send({ permissionIds: [await permissionId(permission)] });

    it('SUPER_ADMIN con un rol propio que empieza en el futuro no puede agregarle permisos', async () => {
      const own = await insertRole('FUTURE', 3);
      const admin = await createUser([
        'SUPER_ADMIN',
        { code: await codeOf(own), validFrom: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      ]);
      const response = await addTo(admin, own, 'inventory:create:global');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });

    it('SUPER_ADMIN con un rol propio de alcance COST_CENTER no puede agregarle permisos', async () => {
      const own = await insertRole('CC_SCOPED', 3);
      const center = await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro cascada') RETURNING id`,
        [`CASC-${randomUUID().slice(0, 6)}`],
      );
      const admin = await createUser(['SUPER_ADMIN', { code: await codeOf(own), scopeType: 'COST_CENTER', scopeId: center }]);
      const response = await addTo(admin, own, 'asset:read:org_unit');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });

    it('SUPER_ADMIN no agrega permisos al padre de un rol que tiene (llegarían por herencia)', async () => {
      const parent = await insertRole('PARENT', 3);
      const child = await insertRole('CHILD', 4);
      await dataSource.query('UPDATE role SET parent_role_id = $1 WHERE id = $2', [parent, child]);
      const admin = await createUser(['SUPER_ADMIN', await codeOf(child)]);
      const response = await addTo(admin, parent, 'inventory:create:global');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });

    it('SUPER_ADMIN no amplía un rol propio con PUT, pero sí puede quitarle permisos (solo reduce)', async () => {
      const own = await insertRole('OWN_PUT', 3);
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = 'user:read:global'`,
        [own],
      );
      const admin = await createUser(['SUPER_ADMIN', await codeOf(own)]);
      const widen = await call('put', `/roles/${own}/permissions`, admin.token).send({
        permissionIds: [await permissionId('user:read:global'), await permissionId('inventory:create:global')],
      });
      expect(widen.status).toBe(403);
      expect(widen.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
      const reduce = await call('put', `/roles/${own}/permissions`, admin.token).send({ permissionIds: [] });
      expect(reduce.status).toBe(200);
    });

    it('SUPER_ADMIN no hace heredar a un rol propio de otro con permisos que ya tiene', async () => {
      const own = await insertRole('OWN_INHERIT', 3);
      const source = await insertRole('SOURCE', 3);
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = 'user:read:global'`,
        [source],
      );
      const admin = await createUser(['SUPER_ADMIN', await codeOf(own)]);
      const response = await call('patch', `/roles/${own}`, admin.token).send({ parentRoleId: source });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    });

    it('un rol vencido ya no cuenta como propio', async () => {
      const own = await insertRole('EXPIRED', 3);
      const admin = await createUser(['SUPER_ADMIN']);
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, valid_from, valid_until)
         VALUES ($1, $2, 'GLOBAL', NOW() - interval '10 days', NOW() - interval '1 day')`,
        [admin.id, own],
      );
      expect((await addTo(admin, own, 'inventory:create:global')).status).toBe(201);
    });
  });

  describe('motivo obligatorio', () => {
    it('sin motivo o con menos de 3 caracteres: 400 en cada otorgamiento y retiro', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const holder = await createUser(['VIEWER']);
      const role = await insertRole('REASON', 3);
      const permission = await permissionId('inventory:read:global');
      const assignment = await scalar<string>(dataSource, 'SELECT id FROM user_role WHERE user_id = $1', [holder.id]);
      const attempts: Array<[() => ReturnType<typeof call>, string]> = [
        [() => call('post', '/roles', admin.token, false).send({ code: `NO_REASON_${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Sin motivo' }), 'POST /roles'],
        [() => call('patch', `/roles/${role}`, admin.token, false).send({ name: 'Otro' }), 'PATCH /roles/:id'],
        [() => call('post', `/roles/${role}/permissions`, admin.token, false).send({ permissionIds: [permission], reason: 'ab' }), 'POST permisos'],
        [() => call('put', `/roles/${role}/permissions`, admin.token, false).send({ permissionIds: [permission], reason: '   ' }), 'PUT permisos'],
        [() => call('delete', `/roles/${role}/permissions/${permission}`, admin.token, false), 'DELETE permiso'],
        [() => call('post', `/users/${holder.id}/roles`, admin.token, false).send({ roleId: role }), 'POST rol a usuario'],
        [() => call('delete', `/users/${holder.id}/roles/${assignment}`, admin.token, false), 'DELETE rol de usuario'],
      ];
      for (const [send, label] of attempts) {
        const response = await send();
        expect(response.status, label).toBe(400);
        expect(response.body.error.code, label).toBe('VALIDATION_FAILED');
      }
      expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM role_permission WHERE role_id = $1', [role])).toBe(0);
    });
  });

  describe('GET /roles/grants-history', () => {
    it('la Directora y el Auditor lo leen sin administrar roles; muestra quién, qué, a quién, desde dónde y por qué', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const target = await createUser([]);
      const viewerRole = await roleId('VIEWER');
      const granted = await call('post', `/users/${target.id}/roles`, admin.token).send({ roleId: viewerRole, scopeType: 'GLOBAL' });
      expect(granted.status).toBe(201);
      const revoked = await call('delete', `/users/${target.id}/roles/${granted.body.data.id as string}`, admin.token);
      expect(revoked.status).toBe(200);
      expect(
        await scalar<string>(dataSource, 'SELECT revocation_reason FROM user_role WHERE id = $1', [granted.body.data.id]),
      ).toBe(GRANT_REASON);

      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const auditor = await createUser(['AUDITOR']);
      for (const reader of [director, auditor, admin]) {
        const history = await call('get', '/roles/grants-history', reader.token).query({ userId: target.id });
        expect(history.status).toBe(200);
        const items = history.body.data.items as Array<Record<string, unknown>>;
        expect(items.map((item) => item['event'])).toEqual(['USER_ROLE_REVOKED', 'USER_ROLE_GRANTED']);
        expect(items[1]).toMatchObject({
          performedBy: { id: admin.id, name: expect.stringContaining('Cascada') },
          targetUser: { id: target.id },
          role: { id: viewerRole, code: 'VIEWER' },
          scopeType: 'GLOBAL',
          scopeId: null,
          reason: GRANT_REASON,
          userAgent: USER_AGENT,
          ipAddress: expect.stringMatching(/^198\.20\./),
        });
        expect(items[1]).not.toHaveProperty('changes');
        expect(history.body.data.pagination).toMatchObject({ page: 1, totalItems: 2 });
      }

      const viewer = await createUser(['VIEWER']);
      expect((await call('get', '/roles/grants-history', viewer.token)).status).toBe(403);
      expect((await call('get', '/roles/grants-history', director.token).query({ roleId: 'x' })).status).toBe(400);
    });

    it('filtra por rol y permiso, pagina y muestra los permisos agregados y quitados', async () => {
      const admin = await createUser(['SUPER_ADMIN']);
      const role = await insertRole('HISTORY', 3);
      const first = await permissionId('inventory:read:global');
      const second = await permissionId('loan:read:global');
      expect((await call('post', `/roles/${role}/permissions`, admin.token).send({ permissionIds: [first] })).status).toBe(201);
      expect((await call('put', `/roles/${role}/permissions`, admin.token).send({ permissionIds: [second] })).status).toBe(200);

      const director = await createUser(['INTERNAL_CONTROL_DIRECTOR']);
      const byRole = await call('get', '/roles/grants-history', director.token).query({ roleId: role, pageSize: 1 });
      expect(byRole.status).toBe(200);
      expect(byRole.body.data.pagination).toMatchObject({ page: 1, pageSize: 1, totalItems: 2, totalPages: 2 });
      expect(byRole.body.data.items[0]).toMatchObject({
        event: 'ROLE_PERMISSIONS_CHANGED',
        addedPermissions: [{ id: second, code: 'loan:read:global', label: 'Ver todos los préstamos' }],
        removedPermissions: [{ id: first, code: 'inventory:read:global', label: 'Consultar tomas físicas' }],
      });
      // La etiqueta es la del catálogo de permisos (GET /permissions/catalog), no un mapa aparte.
      const catalog = await call('get', '/permissions/catalog', admin.token);
      const catalogDescription = (id: string): unknown =>
        (catalog.body.data as Array<{ resources: Array<{ permissions: Array<{ id: string; description: string | null }> }> }>)
          .flatMap((module) => module.resources)
          .flatMap((resource) => resource.permissions)
          .find((item) => item.id === id)?.description;
      expect(catalogDescription(second)).toBe('Ver todos los préstamos');
      expect(catalogDescription(first)).toBe('Consultar tomas físicas');

      // Un permiso que ya no existe conserva el código guardado en la bitácora, sin etiqueta.
      const temporary = await scalar<string>(
        dataSource,
        `INSERT INTO permission (code, module, resource_type, resource_label, action, scope_level, description)
         VALUES ('loan:it_label:global', 'LOAN', 'loan', 'Préstamos', 'it_label', 'GLOBAL', NULL) RETURNING id`,
      );
      // Quien otorga debe tenerlo (cascada): se le da a SUPER_ADMIN solo para esta prueba.
      await grantSql('SUPER_ADMIN', 'loan:it_label:global');
      const grantTemporary = await call('post', `/roles/${role}/permissions`, admin.token).send({ permissionIds: [temporary] });
      expect(grantTemporary.status, JSON.stringify(grantTemporary.body)).toBe(201);
      const noDescription = await call('get', '/roles/grants-history', director.token).query({ roleId: role, permissionId: temporary });
      expect(noDescription.body.data.items[0].addedPermissions).toEqual([
        { id: temporary, code: 'loan:it_label:global', label: 'Préstamos' },
      ]);
      await dataSource.query('DELETE FROM role_permission WHERE permission_id = $1', [temporary]);
      await dataSource.query('DELETE FROM permission WHERE id = $1', [temporary]);
      const deleted = await call('get', '/roles/grants-history', director.token).query({ roleId: role, permissionId: temporary });
      expect(deleted.body.data.items[0].addedPermissions).toEqual([{ id: temporary, code: 'loan:it_label:global', label: null }]);

      const byPermission = await call('get', '/roles/grants-history', director.token).query({ roleId: role, permissionId: first });
      expect((byPermission.body.data.items as unknown[]).length).toBe(2);
      const byEvent = await call('get', '/roles/grants-history', director.token).query({
        roleId: role,
        event: 'ROLE_CREATED',
      });
      expect(byEvent.body.data.items).toEqual([]);
      const future = await call('get', '/roles/grants-history', director.token).query({
        roleId: role,
        from: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(future.body.data.items).toEqual([]);
    });
  });
});
