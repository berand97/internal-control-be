import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, openTestSession } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

const CODE_MESSAGE = 'Use mayúsculas sin tildes, números y guion bajo. Debe empezar con letra.';
const HEAD_MESSAGE = 'Escriba solo números, hasta 20.';

describe('Validaciones de unidades: código, nombre repetido y advertencias por campo (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (
      openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>
    )[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  const token = async (user: AuthenticatedUser) =>
    app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });

  const grant = (userId: string, role: string) =>
    dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`, [
      userId,
      role,
    ]);

  const post = (body: Record<string, unknown>) => http().post('/api/v1/organizational-units').set(auth('admin')).send(body);

  const createUnit = async (key: string, body: Record<string, unknown>) => {
    const response = await post(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    ids[key] = response.body.data.id as string;
    return response;
  };

  const patchUnit = (key: string, body: Record<string, unknown>) =>
    http().patch(`/api/v1/organizational-units/${ids[key]}`).set(auth('admin')).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const admin = await createActor(dataSource);
    await grant(admin.id, 'INTERNAL_CONTROL_DIRECTOR');
    tokens['admin'] = await token(admin);

    await createUnit('dir', { code: 'IT_OV_DIR', name: 'Dirección Validación', type: 'DEPARTMENT', codePrefix: '96' });
    await createUnit('otra', { code: 'IT_OV_OTRA', name: 'Otra Dirección Validación', type: 'DEPARTMENT' });
    await createUnit('cal', { code: 'IT_OV_CAL', name: 'Calidad Validación', type: 'OFFICE', parentId: ids['dir'] });
    await createUnit('cal2', { code: 'IT_OV_CAL_OTRA', name: 'Calidad Validación', type: 'OFFICE', parentId: ids['otra'] });
    await createUnit('root', { code: 'IT_OV_RAIZ', name: 'Oficina Raíz Validación', type: 'OFFICE' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('código interno con formato inválido: 400 VALIDATION_FAILED con el mensaje en el campo code', async () => {
    const created = await post({ code: 'oficina-calidad', name: 'Oficina Código Validación', type: 'OFFICE' });
    expect(created.status).toBe(400);
    expect(created.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'code', message: CODE_MESSAGE }],
    });

    const tooLong = await post({ code: 'A'.repeat(21), name: 'Oficina Código Validación', type: 'OFFICE' });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details).toEqual([{ field: 'code', message: 'Use hasta 20 caracteres.' }]);

    const patched = await patchUnit('root', { code: '9OFICINA' });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'code', message: CODE_MESSAGE }] });

    const operation = openapi.paths['/api/v1/organizational-units']?.post?.requestBody as
      | { content: Record<string, { schema: { $ref: string } }> }
      | undefined;
    const ref = operation?.content['application/json']?.schema.$ref.split('/').pop() ?? '';
    const properties = (openapi.components?.schemas?.[ref] as { properties?: Record<string, { pattern?: string }> } | undefined)
      ?.properties ?? {};
    expect(properties['code']?.pattern).toBe('^[A-Z][A-Z0-9_]*$');
    expect(properties['headCostCenterCode']?.pattern).toBe('^[0-9]{1,20}$');
  });

  it('centro propio: de 1 a 20 dígitos; el pendiente trae warningDetails en headCostCenterCode', async () => {
    const letters = await patchUnit('root', { headCostCenterCode: '15A0' });
    expect(letters.status).toBe(400);
    expect(letters.body.error.details).toEqual([{ field: 'headCostCenterCode', message: HEAD_MESSAGE }]);
    const tooLong = await patchUnit('root', { headCostCenterCode: '1'.repeat(21) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details).toEqual([{ field: 'headCostCenterCode', message: HEAD_MESSAGE }]);

    const code = '9'.repeat(20);
    const pending = await patchUnit('root', { headCostCenterCode: code });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    expectConforms('patch', '/api/v1/organizational-units/{id}', 200, pending.body);
    const message = `El centro ${code} aún no existe. Quedará como centro propio cuando lo creen.`;
    expect(pending.body.data).toMatchObject({
      headCostCenterCode: code,
      headCostCenterPending: true,
      warnings: [message],
      warningDetails: [{ field: 'headCostCenterCode', code: 'ORG_UNIT_HEAD_CENTER_PENDING', message }],
    });
    expect((await patchUnit('root', { headCostCenterCode: null })).status).toBe(200);
  });

  it('prefijo fuera del rango del jefe: sigue siendo advertencia, ahora con campo y código', async () => {
    const created = await post({ code: 'IT_OV_FUERA', name: 'Oficina Fuera Validación', type: 'OFFICE', parentId: ids['dir'], codePrefix: '9581' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectConforms('post', '/api/v1/organizational-units', 201, created.body);
    const warnings = created.body.data.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Oficina Fuera Validación quedó bajo Dirección Validación, pero su prefijo 9581 (no empieza por 96|es de la rama de .+)\.$/);
    expect(created.body.data.warningDetails).toEqual([
      { field: 'codePrefix', code: 'ORG_UNIT_PREFIX_OUTSIDE_PARENT', message: warnings[0] },
    ]);
    ids['fuera'] = created.body.data.id as string;
  });

  it('nombre de una hermana activa (sin tildes ni mayúsculas): 409 ORG_UNIT_NAME_DUPLICATE al crear, renombrar, mover y reactivar', async () => {
    const created = await post({ code: 'IT_OV_CAL_DOS', name: '  CALIDAD validacion ', type: 'OFFICE', parentId: ids['dir'] });
    expect(created.status).toBe(409);
    expect(Object.keys(openapi.paths['/api/v1/organizational-units']?.post?.responses ?? {})).toContain('409');
    expect(created.body.error).toMatchObject({
      code: 'ORG_UNIT_NAME_DUPLICATE',
      message: 'Ya existe Calidad Validación en Dirección Validación.',
      details: [{ field: 'name', message: ids['cal'] }],
    });

    const atRoot = await post({ code: 'IT_OV_RAIZ_DOS', name: 'oficina raiz validación', type: 'OFFICE' });
    expect(atRoot.status).toBe(409);
    expect(atRoot.body.error).toMatchObject({
      code: 'ORG_UNIT_NAME_DUPLICATE',
      message: 'Ya existe Oficina Raíz Validación en el primer nivel.',
      details: [{ field: 'name', message: ids['root'] }],
    });

    const renamed = await patchUnit('fuera', { name: 'Calidád Validación' });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toMatchObject({ code: 'ORG_UNIT_NAME_DUPLICATE', details: [{ field: 'name', message: ids['cal'] }] });

    const moved = await patchUnit('cal2', { parentId: ids['dir'] });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatchObject({ code: 'ORG_UNIT_NAME_DUPLICATE', details: [{ field: 'name', message: ids['cal'] }] });

    expect((await patchUnit('cal2', { isActive: false })).status).toBe(200);
    expect((await patchUnit('cal2', { parentId: ids['dir'] })).status).toBe(200);
    const reactivated = await patchUnit('cal2', { isActive: true });
    expect(reactivated.status).toBe(409);
    expect(reactivated.body.error).toMatchObject({ code: 'ORG_UNIT_NAME_DUPLICATE', details: [{ field: 'name', message: ids['cal'] }] });
    const [row] = (await dataSource.query('SELECT is_active, parent_id FROM organizational_unit WHERE id = $1', [ids['cal2']])) as Array<{
      is_active: boolean;
      parent_id: string;
    }>;
    expect(row).toEqual({ is_active: false, parent_id: ids['dir'] });
  });

  it('structure-pending lista las repetidas de antes; editar otros campos de una repetida sí se guarda', async () => {
    await createUnit('legacy', { code: 'IT_OV_LEGADO', name: 'Legado Validación', type: 'OFFICE', parentId: ids['dir'] });
    await createUnit('legacyRoot', { code: 'IT_OV_LEGADO_RAIZ', name: 'Legado Raíz Validación', type: 'OFFICE' });
    await dataSource.query(`UPDATE organizational_unit SET name = 'CALIDAD VALIDACION' WHERE id = $1`, [ids['legacy']]);
    await dataSource.query(`UPDATE organizational_unit SET name = 'Oficina Raiz Validacion' WHERE id = $1`, [ids['legacyRoot']]);

    const pending = await http().get('/api/v1/organizational-units/structure-pending').set(auth('admin'));
    expect(pending.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/structure-pending', 200, pending.body);
    const ours = (pending.body.data.duplicateSiblingNames as Array<{ units: Array<{ code: string }> }>).filter((group) =>
      group.units.some((unit) => unit.code.startsWith('IT_OV_')),
    );
    expect(ours).toEqual([
      {
        parentId: ids['dir'],
        parentName: 'Dirección Validación',
        name: 'Calidad Validación',
        units: [
          { id: ids['cal'], code: 'IT_OV_CAL' },
          { id: ids['legacy'], code: 'IT_OV_LEGADO' },
        ],
      },
      {
        parentId: null,
        parentName: null,
        name: 'Oficina Raiz Validacion',
        units: [
          { id: ids['legacyRoot'], code: 'IT_OV_LEGADO_RAIZ' },
          { id: ids['root'], code: 'IT_OV_RAIZ' },
        ],
      },
    ]);

    const recolored = await patchUnit('legacy', { color: '#29b1b2', code: 'IT_OV_LEGADO_2', type: 'DEPARTMENT' });
    expect(recolored.status, JSON.stringify(recolored.body)).toBe(200);
    expect(recolored.body.data).toMatchObject({ name: 'CALIDAD VALIDACION', color: '#29b1b2', warnings: [], warningDetails: [] });
    const recased = await patchUnit('legacyRoot', { name: 'OFICINA RAÍZ VALIDACIÓN' });
    expect(recased.status, JSON.stringify(recased.body)).toBe(200);

    expect((await patchUnit('legacy', { name: 'Calidad Legado Validación' })).status).toBe(200);
    const after = await http().get('/api/v1/organizational-units/structure-pending').set(auth('admin'));
    expect(
      (after.body.data.duplicateSiblingNames as Array<{ parentId: string | null }>).filter((group) => group.parentId === ids['dir']),
    ).toEqual([]);
  });
});
