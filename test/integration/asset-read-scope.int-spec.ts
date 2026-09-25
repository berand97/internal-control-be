import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, scalar } from './helpers.js';

interface ListBody {
  items: Array<{ id: string; internalCode: string }>;
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
}

describe('Alcance de lectura de activos por centro de costo (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let centerA: string;
  let centerB: string;
  const assetsA: string[] = [];
  const assetsB: string[] = [];
  const tokens: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const get = (path: string, who: string, query: Record<string, string | number> = {}) =>
    http().get(`/api/v1/assets${path}`).query(query).set('Authorization', `Bearer ${tokens[who] ?? ''}`);
  const list = async (who: string, query: Record<string, string | number> = {}): Promise<ListBody> => {
    const response = await get('', who, query);
    expect(response.status).toBe(200);
    return response.body.data as ListBody;
  };

  const tokenFor = (user: AuthenticatedUser) =>
    app.get(TokenService).signAccessToken({ ...user, sessionId: randomUUID() });

  /** Crea un usuario con las asignaciones dadas (SQL directo sobre user_role). */
  const userWith = async (
    name: string,
    assignments: ReadonlyArray<{
      role: string;
      scopeType: 'GLOBAL' | 'COST_CENTER' | 'ORG_UNIT';
      scopeId?: string;
      extra?: string;
    }>,
  ) => {
    const user = await createActor(dataSource);
    for (const assignment of assignments) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id${assignment.extra ? ', valid_from, valid_until, revoked_at' : ''})
         SELECT $1, id, $2, $3${assignment.extra ? `, ${assignment.extra}` : ''} FROM role WHERE code = $4`,
        [user.id, assignment.scopeType, assignment.scopeId ?? null, assignment.role],
      );
    }
    tokens[name] = tokenFor(user);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);

    const creator = await createActor(dataSource);
    centerA = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('SCOPE-A', 'Centro A del jefe') RETURNING id`,
    );
    centerB = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('SCOPE-B', 'Centro B ajeno') RETURNING id`,
    );
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name) VALUES ('SCOPE', 'Alcance') RETURNING id`,
    );
    const insertAsset = (code: string, centerId: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
           current_cost_center_id, created_by)
         VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2021-03-01', $4, $5)
         RETURNING id`,
        [code, `Activo de alcance ${code}`, categoryId, centerId, creator.id],
      );
    for (let index = 1; index <= 5; index += 1) {
      assetsA.push(await insertAsset(`SCOPE-A-${index}`, centerA));
    }
    for (let index = 1; index <= 3; index += 1) {
      assetsB.push(await insertAsset(`SCOPE-B-${index}`, centerB));
    }
    // Mismo prefijo de placa en ambos centros: la búsqueda debe respetar el alcance.
    await dataSource.query(
      `INSERT INTO asset_identifier (asset_id, identifier_type, value, origin)
       VALUES ($1, 'LEGACY_CODE', 'PLACA-SCOPE-001', 'IMPORTED'), ($2, 'LEGACY_CODE', 'PLACA-SCOPE-002', 'IMPORTED')`,
      [assetsA[0], assetsB[0]],
    );
    // Sin movimientos por SQL directo: romperían la cadena de firmas que verifica movement-signature.
    // El timeline trae al menos el evento de compra (acquisition_date).

    await userWith('director', [{ role: 'INTERNAL_CONTROL_DIRECTOR', scopeType: 'GLOBAL' }]);
    await userWith('jefe', [{ role: 'DEPARTMENT_HEAD', scopeType: 'COST_CENTER', scopeId: centerA }]);
    await userWith('consulta', [{ role: 'VIEWER', scopeType: 'COST_CENTER', scopeId: centerA }]);
    await userWith('dosCentros', [
      { role: 'DEPARTMENT_HEAD', scopeType: 'COST_CENTER', scopeId: centerA },
      { role: 'CUSTODIAN', scopeType: 'COST_CENTER', scopeId: centerB },
    ]);
    await userWith('jefeGlobal', [{ role: 'DEPARTMENT_HEAD', scopeType: 'GLOBAL' }]);
    await userWith('revocado', [
      { role: 'DEPARTMENT_HEAD', scopeType: 'COST_CENTER', scopeId: centerA, extra: `NOW() - interval '10 days', NULL, NOW()` },
      { role: 'VIEWER', scopeType: 'COST_CENTER', scopeId: centerB },
    ]);
    await userWith('vencido', [
      {
        role: 'DEPARTMENT_HEAD',
        scopeType: 'COST_CENTER',
        scopeId: centerA,
        extra: `NOW() - interval '10 days', NOW() - interval '1 day', NULL`,
      },
    ]);
    await userWith('futuro', [
      {
        role: 'DEPARTMENT_HEAD',
        scopeType: 'COST_CENTER',
        scopeId: centerA,
        extra: `NOW() + interval '1 day', NULL, NULL`,
      },
    ]);
    await userWith('unidad', [{ role: 'DEPARTMENT_HEAD', scopeType: 'ORG_UNIT', scopeId: randomUUID() }]);
    await userWith('sinRol', []);
  });

  afterAll(async () => {
    await app.close();
  });

  it('el jefe con un centro ve exactamente los activos de ese centro', async () => {
    const page = await list('jefe', { pageSize: 100 });
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.id).sort()).toEqual([...assetsA].sort());
    expect(page.hasNext).toBe(false);
    const viewer = await list('consulta', { pageSize: 100 });
    expect(viewer.items.map((item) => item.id).sort()).toEqual([...assetsA].sort());
  });

  it('total y paginación son del conjunto filtrado', async () => {
    const seen: string[] = [];
    for (const pageNumber of [1, 2, 3]) {
      const page = await list('jefe', { pageSize: 2, page: pageNumber, sortBy: 'internalCode', sortOrder: 'asc' });
      expect(page.total).toBe(5);
      expect(page.hasNext).toBe(pageNumber < 3);
      seen.push(...page.items.map((item) => item.internalCode));
    }
    expect(seen).toEqual(['SCOPE-A-1', 'SCOPE-A-2', 'SCOPE-A-3', 'SCOPE-A-4', 'SCOPE-A-5']);
    expect((await list('jefe', { pageSize: 2, page: 4 })).items).toEqual([]);
  });

  it('los demás filtros se combinan con el alcance y no lo amplían', async () => {
    expect((await list('jefe', { costCenterId: centerB })).total).toBe(0);
    expect((await list('jefe', { costCenterId: centerA })).total).toBe(5);
    expect((await list('jefe', { q: 'Activo de alcance', pageSize: 100 })).total).toBe(5);
    expect((await list('jefe', { operationalStatus: 'IN_USE', pageSize: 100 })).total).toBe(5);
  });

  it('la búsqueda por identificador respeta el alcance', async () => {
    const mine = await list('jefe', { q: 'PLACA-SCOPE' });
    expect(mine.items.map((item) => item.id)).toEqual([assetsA[0]]);
    expect(mine.total).toBe(1);
    expect((await list('jefe', { q: 'PLACA-SCOPE-002' })).total).toBe(0);
    expect((await list('director', { q: 'PLACA-SCOPE' })).total).toBe(2);
  });

  it('dos asignaciones COST_CENTER suman sus centros', async () => {
    const page = await list('dosCentros', { pageSize: 100 });
    expect(page.total).toBe(8);
  });

  it('detalle y timeline fuera de alcance responden idéntico a un activo inexistente', async () => {
    const missing = randomUUID();
    for (const path of ['', '/timeline']) {
      const outside = await get(`/${assetsB[0]}${path}`, 'jefe');
      const nonexistent = await get(`/${missing}${path}`, 'jefe');
      expect(outside.status).toBe(404);
      expect(outside.body).toEqual({
        type: 'ERROR',
        action: 'CANCEL',
        error: { code: 'RESOURCE_NOT_FOUND', message: 'El recurso solicitado no existe' },
      });
      expect(outside.status).toBe(nonexistent.status);
      expect(outside.body).toEqual(nonexistent.body);
    }
  });

  it('detalle y timeline dentro de alcance funcionan', async () => {
    const detail = await get(`/${assetsA[0]}`, 'jefe');
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(assetsA[0]);
    const timeline = await get(`/${assetsA[0]}/timeline`, 'jefe');
    expect(timeline.status).toBe(200);
    expect(timeline.body.data.assetId).toBe(assetsA[0]);
    expect(timeline.body.data.total).toBeGreaterThan(0);
  });

  it('el permiso global no cambia: ve todo, incluido el detalle de cualquier centro', async () => {
    const all = await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset');
    expect((await list('director', { pageSize: 1 })).total).toBe(all);
    expect((await list('director', { costCenterId: centerB })).total).toBe(3);
    expect((await get(`/${assetsB[0]}`, 'director')).status).toBe(200);
    expect((await get(`/${assetsB[0]}/timeline`, 'director')).status).toBe(200);
  });

  it('una asignación revocada, vencida o aún no vigente no da acceso a su centro', async () => {
    const revoked = await list('revocado', { pageSize: 100 });
    expect(revoked.items.map((item) => item.id).sort()).toEqual([...assetsB].sort());
    expect((await get(`/${assetsA[0]}`, 'revocado')).status).toBe(404);
    expect((await get(`/${assetsA[0]}/timeline`, 'revocado')).status).toBe(404);
    // Sin ninguna otra asignación vigente no queda ningún permiso de lectura.
    for (const who of ['vencido', 'futuro']) {
      for (const path of ['', `/${assetsA[0]}`, `/${assetsA[0]}/timeline`]) {
        const response = await get(path, who);
        expect({ who, path, status: response.status, code: response.body.error?.code }).toEqual({
          who,
          path,
          status: 403,
          code: 'INSUFFICIENT_PERMISSIONS',
        });
      }
    }
  });

  it('sin centro asignado (rol acotado asignado con alcance GLOBAL) no ve nada y se le dice por qué', async () => {
    for (const who of ['jefeGlobal']) {
      for (const path of ['', `/${assetsA[0]}`, `/${assetsA[0]}/timeline`]) {
        const response = await get(path, who);
        expect({ who, path, status: response.status, body: response.body }).toEqual({
          who,
          path,
          status: 403,
          body: {
            type: 'ERROR',
            action: 'CONTACT_SUPPORT',
            error: {
              code: 'SCOPE_NO_COST_CENTER',
              message:
                'Tu rol solo da acceso a los centros de costo que tengas asignados y no tienes ninguno. Pide a Control Interno que te asigne el rol sobre tu centro de costo.',
            },
          },
        });
      }
    }
  });

  it('una asignación ORG_UNIT no da centros y se explica', async () => {
    for (const path of ['', `/${assetsA[0]}`, `/${assetsA[0]}/timeline`]) {
      const response = await get(path, 'unidad');
      expect(response.status).toBe(403);
      expect(response.body.action).toBe('CONTACT_SUPPORT');
      expect(response.body.error.code).toBe('SCOPE_ORG_UNIT_UNRESOLVED');
    }
  });

  it('sin ningún permiso de lectura es 403 INSUFFICIENT_PERMISSIONS', async () => {
    for (const path of ['', `/${assetsA[0]}`, `/${assetsA[0]}/timeline`, '/acquisition-types']) {
      const response = await get(path, 'sinRol');
      expect(response.status).toBe(403);
      expect(response.body.error).toEqual({
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'Requiere permiso asset:read:global o asset:read:org_unit',
      });
    }
  });

  it('el catálogo de tipos de adquisición basta con cualquiera de los dos permisos', async () => {
    for (const who of ['director', 'jefe', 'jefeGlobal', 'unidad']) {
      const response = await get('/acquisition-types', who);
      expect({ who, status: response.status }).toEqual({ who, status: 200 });
      expect((response.body.data as Array<{ code: string }>).map((item) => item.code)).toContain('PURCHASE');
    }
  });

  it('la escritura sigue exigiendo el permiso global: el jefe no puede modificar ni en su centro', async () => {
    const response = await http()
      .patch(`/api/v1/assets/${assetsA[0]}`)
      .set('Authorization', `Bearer ${tokens['jefe'] ?? ''}`)
      .send({ description: 'Cambio no permitido' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('OpenAPI documenta los 403 de alcance y el 404 indistinguible', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const paths = Object.entries(document.paths);
    const read = (suffix: string) => paths.find(([path]) => path.endsWith(suffix))?.[1].get;
    for (const suffix of ['/assets', '/assets/{id}', '/assets/{id}/timeline']) {
      const forbidden = read(suffix)?.responses['403'] as
        | { description: string; content: { 'application/json': { examples: Record<string, { value: { error: { code: string } } }> } } }
        | undefined;
      const codes = Object.values(forbidden?.content['application/json'].examples ?? {}).map((example) => example.value.error.code);
      expect({ suffix, codes: codes.sort() }).toEqual({
        suffix,
        codes: ['INSUFFICIENT_PERMISSIONS', 'SCOPE_NO_COST_CENTER', 'SCOPE_ORG_UNIT_UNRESOLVED'],
      });
    }
    expect(read('/assets/{id}')?.responses['404']).toMatchObject({ description: expect.stringContaining('fuera del alcance') });
  });
});
