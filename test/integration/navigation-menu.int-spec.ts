// Menú administrable: los ítems sembrados por 1767225740000 (importar, entregas, documentos), el ícono como dato en
// /auth/me y en el CRUD, el catálogo cerrado de íconos, y la migración ante un /imports creado a mano.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { NAVIGATION_ICONS } from '../../src/common/authorization/navigation-icons.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { createOpenApiDocument } from '../../src/common/swagger/openapi-document.js';
import { NavigationIconsAndNewItems1767225740000 } from '../../src/database/migrations/1767225740000-navigation-icons-and-new-items.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { NavigationService } from '../../src/modules/navigation/services/navigation.service.js';
import { scalar } from './helpers.js';

interface MenuItem {
  readonly path: string;
  readonly resource: string;
  readonly label: string;
  readonly icon: string | null;
}

describe('Menú: ítems nuevos e íconos como dato (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });

  /** Usuario activo con sesión (MFA verificado) y, si se indica, un rol GLOBAL o un rol ad hoc con esos permisos. */
  const user = async (name: string, grant: { role?: string; permissions?: ReadonlyArray<string> }) => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ($1, 'Menú', $2) RETURNING id`,
      [name, `menu.${suffix}@unac.edu.co`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `menu.${suffix}`],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', NOW())`,
      [sessionId, userId, randomUUID()],
    );
    let roleCode = grant.role;
    if (grant.permissions) {
      roleCode = `IT_MENU_${suffix.toUpperCase()}`;
      await dataSource.query(`INSERT INTO role (code, name) VALUES ($1, $1)`, [roleCode]);
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id FROM role r JOIN permission p ON p.code = ANY($2::text[]) WHERE r.code = $1`,
        [roleCode, grant.permissions],
      );
    }
    if (roleCode) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [userId, roleCode],
      );
    }
    tokens[name] = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `menu.${suffix}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
  };

  const menu = async (who: string): Promise<ReadonlyArray<MenuItem>> => {
    const me = await http().get('/api/v1/auth/me').set(auth(who)).expect(200);
    return me.body.data.navigation as ReadonlyArray<MenuItem>;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    await user('creator', { permissions: ['asset:read:global', 'asset:create:global'] });
    await user('reader', { permissions: ['asset:read:global'] });
    await user('orgReader', { permissions: ['asset:read:org_unit'] });
    await user('admin', { permissions: ['navigation:manage:global'] });
    await user('director', { role: 'INTERNAL_CONTROL_DIRECTOR' });
    await user('viewer', { role: 'VIEWER' });
    await user('roleManager', { permissions: ['role:read:global', 'role:manage:global'] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('la migración deja el menú sembrado con íconos, /imports, /handovers y /documents', async () => {
    const rows = (await dataSource.query(
      `SELECT path, label, resource, required_action, sort_order, icon FROM navigation_item ORDER BY sort_order, path`,
    )) as Array<{ path: string; label: string; resource: string; required_action: string; sort_order: number; icon: string | null }>;
    expect(rows.map((row) => [row.path, row.icon])).toEqual([
      ['/users', 'users'],
      ['/roles', 'shield'],
      ['/roles/grants-history', 'shield'],
      ['/campus', 'map-pinned'],
      ['/organizational-units', 'landmark'],
      ['/cost-centers', 'wallet'],
      ['/categories', 'tags'],
      ['/assets', 'package'],
      ['/imports', 'file-spreadsheet'],
      ['/handovers', 'package-check'],
      ['/inventories', 'clipboard-check'],
      ['/inventories/calendar', 'clipboard-check'],
      ['/inventories/catalogs', 'tags'],
      ['/loans', 'handshake'],
      ['/depreciation', 'calculator'],
      ['/documents', 'file-text'],
      ['/storage', 'hard-drive'],
      ['/mail', 'circle'],
      ['/email-templates', 'mail'],
      ['/features', 'panels-top-left'],
      ['/navigation', 'list-tree'],
    ]);
    expect(rows.find((row) => row.path === '/documents')).toMatchObject({
      label: 'Documentos',
      resource: 'document_template',
      required_action: 'read',
    });
    expect(rows.find((row) => row.path === '/imports')).toMatchObject({
      label: 'Importar desde Excel',
      resource: 'asset',
      required_action: 'create',
    });
    expect(rows.find((row) => row.path === '/handovers')).toMatchObject({
      label: 'Entregas de activos',
      resource: 'asset',
      required_action: 'read',
    });
  });

  it('/imports solo con asset:create; /handovers con asset:read; el ícono viaja en /auth/me', async () => {
    const creator = await menu('creator');
    expect(creator.map((item) => item.path)).toEqual(['/assets', '/imports', '/handovers']);
    expect(creator.map((item) => item.icon)).toEqual(['package', 'file-spreadsheet', 'package-check']);

    const reader = await menu('reader');
    expect(reader.map((item) => item.path)).toEqual(['/assets', '/handovers']);
    expect(reader.find((item) => item.path === '/imports')).toBeUndefined();

    // El menú no mira el alcance: asset:read:org_unit también publica /handovers aunque la ruta del frontend
    // exija asset:read:global (comportamiento previo de actionSatisfies, documentado en el reporte).
    const orgReader = await menu('orgReader');
    expect(orgReader.map((item) => item.path)).toEqual(['/assets', '/handovers']);
  });

  it('Historial de permisos: lo publica role:audit (la Directora, sin role:read); ni un VIEWER ni administrar roles', async () => {
    expect(
      await dataSource.query(
        `SELECT module, module_label, resource, label, required_action, icon FROM navigation_item WHERE path = '/roles/grants-history'`,
      ),
    ).toEqual([
      {
        module: 'USER',
        module_label: 'Administración',
        resource: 'role',
        label: 'Historial de permisos',
        required_action: 'audit',
        icon: 'shield',
      },
    ]);
    const director = await http().get('/api/v1/auth/me').set(auth('director')).expect(200);
    expect(director.body.data.permissions).toContain('role:audit:global');
    expect(director.body.data.permissions).not.toContain('role:read:global');
    const directorMenu = director.body.data.navigation as ReadonlyArray<MenuItem>;
    expect(directorMenu.find((item) => item.path === '/roles/grants-history')).toMatchObject({
      label: 'Historial de permisos',
      icon: 'shield',
    });
    expect(directorMenu.find((item) => item.path === '/roles')).toBeUndefined();
    expect((await menu('viewer')).find((item) => item.path === '/roles/grants-history')).toBeUndefined();
    const manager = await menu('roleManager');
    expect(manager.map((item) => item.path)).toContain('/roles');
    expect(manager.find((item) => item.path === '/roles/grants-history')).toBeUndefined();
  });

  it('el CRUD publica el catálogo de íconos, fija uno válido y rechaza uno fuera del catálogo', async () => {
    const catalog = await http().get('/api/v1/navigation/icons').set(auth('admin')).expect(200);
    expect(catalog.body.data.icons).toEqual([...NAVIGATION_ICONS]);
    await http().get('/api/v1/navigation/icons').set(auth('reader')).expect(403);

    const bad = await http()
      .post('/api/v1/navigation')
      .set(auth('admin'))
      .send({ module: 'ASSET', moduleLabel: 'Activos', resource: 'asset', path: '/it-menu-bad', label: 'Malo', requiredAction: 'read', icon: 'rocket' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('icon');
    expect(Number(await scalar<string>(dataSource, `SELECT count(*) FROM navigation_item WHERE path = '/it-menu-bad'`))).toBe(0);

    const created = await http()
      .post('/api/v1/navigation')
      .set(auth('admin'))
      .send({ module: 'ASSET', moduleLabel: 'Activos', resource: 'asset', path: '/it-menu', label: 'Prueba', requiredAction: 'read', sortOrder: 999 })
      .expect(201);
    expect(created.body.data.icon).toBeNull();
    const id = created.body.data.id as string;

    const withIcon = await http().patch(`/api/v1/navigation/${id}`).set(auth('admin')).send({ icon: 'upload' }).expect(200);
    expect(withIcon.body.data.icon).toBe('upload');
    await http().patch(`/api/v1/navigation/${id}`).set(auth('admin')).send({ icon: 'Upload' }).expect(400);
    expect((await menu('reader')).find((item) => item.path === '/it-menu')?.icon).toBe('upload');

    const cleared = await http().patch(`/api/v1/navigation/${id}`).set(auth('admin')).send({ icon: null }).expect(200);
    expect(cleared.body.data.icon).toBeNull();
    const list = await http().get('/api/v1/navigation').set(auth('admin')).expect(200);
    expect(list.body.data.find((item: { id: string }) => item.id === id)).toMatchObject({ icon: null, label: 'Prueba' });

    await http().delete(`/api/v1/navigation/${id}`).set(auth('admin')).expect(200);
  });

  it('la BD rechaza un ícono fuera del catálogo aunque se salte la API, y acepta todo el catálogo', async () => {
    await expect(
      dataSource.query(`UPDATE navigation_item SET icon = 'rocket' WHERE path = '/assets'`),
    ).rejects.toThrow(/ck_navigation_item_icon/);
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      for (const icon of NAVIGATION_ICONS) {
        await runner.query(`UPDATE navigation_item SET icon = $1 WHERE path = '/assets'`, [icon]);
      }
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('migración idempotente: respeta un /imports creado a mano y un /document-templates editado, y el down solo quita lo sembrado', async () => {
    const migration = new NavigationIconsAndNewItems1767225740000();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration.down(runner);
      const afterDown = (await runner.query(`SELECT path, label FROM navigation_item ORDER BY path`)) as Array<{ path: string; label: string }>;
      expect(afterDown.map((row) => row.path)).not.toContain('/imports');
      expect(afterDown.map((row) => row.path)).not.toContain('/handovers');
      expect(afterDown.find((row) => row.path === '/document-templates')?.label).toBe('Plantillas');

      // Un administrador creó /imports a su manera y renombró el ítem de plantillas.
      const manualId = await scalar<string>(
        runner as unknown as DataSource,
        `INSERT INTO navigation_item (module, module_label, resource, path, label, required_action, sort_order)
         VALUES ('IMPORT', 'Cargas', 'asset', '/imports', 'Cargar Excel', 'create', 5) RETURNING id`,
      );
      await runner.query(`UPDATE navigation_item SET label = 'Formatos' WHERE path = '/document-templates'`);

      await migration.up(runner);
      const imports = (await runner.query(`SELECT id, module, label, sort_order, icon FROM navigation_item WHERE path = '/imports'`)) as Array<{
        id: string;
        module: string;
        label: string;
        sort_order: number;
        icon: string;
      }>;
      expect(imports).toEqual([{ id: manualId, module: 'IMPORT', label: 'Cargar Excel', sort_order: 5, icon: 'package' }]);
      expect(Number(await scalar<string>(runner as unknown as DataSource, `SELECT count(*) FROM navigation_item WHERE path = '/handovers'`))).toBe(1);
      const templates = (await runner.query(
        `SELECT path, label, icon FROM navigation_item WHERE resource = 'document_template'`,
      )) as Array<{ path: string; label: string; icon: string }>;
      expect(templates).toEqual([{ path: '/document-templates', label: 'Formatos', icon: 'file-text' }]);

      // Correr up otra vez no duplica ni falla.
      await migration.up(runner);
      expect(Number(await scalar<string>(runner as unknown as DataSource, `SELECT count(*) FROM navigation_item WHERE path IN ('/imports', '/handovers')`))).toBe(2);

      await migration.down(runner);
      const remaining = (await runner.query(`SELECT id, path, label FROM navigation_item WHERE path IN ('/imports', '/handovers', '/document-templates') ORDER BY path`)) as Array<{
        id: string;
        path: string;
        label: string;
      }>;
      expect(remaining).toEqual([
        expect.objectContaining({ path: '/document-templates', label: 'Formatos' }),
        { id: manualId, path: '/imports', label: 'Cargar Excel' },
      ]);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    app.get(NavigationService).invalidate();
    expect(Number(await scalar<string>(dataSource, `SELECT count(*) FROM navigation_item WHERE path IN ('/imports', '/handovers', '/documents')`))).toBe(3);
  });

  it('OpenAPI: icon es el enum con nombre NavigationIcon, nullable, en /auth/me y en el CRUD', () => {
    const openapi = createOpenApiDocument(app);
    const schemas = (openapi.components?.schemas ?? {}) as Record<string, Record<string, unknown>>;
    expect(schemas['NavigationIcon']).toMatchObject({ type: 'string', enum: [...NAVIGATION_ICONS] });
    for (const dto of ['NavigationItemResponseDto', 'NavigationAdminItemResponseDto', 'CreateNavigationItemDto']) {
      const properties = (schemas[dto]?.['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const icon = properties['icon'];
      expect(JSON.stringify(icon), dto).toContain('#/components/schemas/NavigationIcon');
      expect(JSON.stringify(icon), dto).toContain('"nullable":true');
    }
    expect(schemas['NavigationItemResponseDto']?.['required']).toContain('icon');
    const catalogProperties = (schemas['NavigationIconCatalogResponseDto']?.['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const catalog = catalogProperties['icons'];
    expect(catalog).toMatchObject({ type: 'array', items: { $ref: '#/components/schemas/NavigationIcon' } });
    const list = JSON.stringify(openapi.paths['/api/v1/navigation']?.get?.responses?.['200']);
    expect(list).toContain('"type":"array"');
  });
});
