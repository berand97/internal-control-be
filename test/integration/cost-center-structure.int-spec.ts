// Estructura de centros de costo con historial (ubicación = unidad, padre y movimiento): HTTP real + PostgreSQL real.
// También la reconstrucción por la importación existente (UPDATE_STRUCTURE) con un Excel mínimo con la forma de la
// hoja 2025 de docs/centros de costo.xlsx (raíces de un dígito, sin «3», subgrupo 3050 por código, 9205 solo por
// nombre y la columna RESPONSABLE), sin mover un solo activo de centro.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { ImportJobsService } from '../../src/modules/staging/services/import-jobs.service.js';
import { createActor, openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

type Cell = string | number | null;

const AGENT = 'it-estructura/1.0';

describe('Estructura de centros de costo con historial (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let admin: AuthenticatedUser;
  let viewer: AuthenticatedUser;
  const tokens: Record<string, string> = {};
  let categoryId = '';
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}`, 'User-Agent': AGENT });

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

  const insertAsset = (code: string, centerId: string) =>
    scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
         current_cost_center_id, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2021-03-01', $4, $5)
       RETURNING id`,
      [code, `Activo ${code}`, categoryId, centerId, admin.id],
    );

  const createUnit = (code: string, name: string, codePrefix: string | null) =>
    http().post('/api/v1/organizational-units').set(auth('admin')).send({ code, name, type: 'VICERECTORATE', codePrefix });

  const createCenter = (body: Record<string, unknown>) => http().post('/api/v1/cost-centers').set(auth('admin')).send(body);

  const place = (centerId: string, body: Record<string, unknown>, who = 'admin') =>
    http().post(`/api/v1/cost-centers/${centerId}/placement`).set(auth(who)).send(body);

  const assetCountsByCenter = () =>
    dataSource.query(
      `SELECT current_cost_center_id AS center, count(*)::int AS assets FROM asset GROUP BY current_cost_center_id ORDER BY 1`,
    ) as Promise<Array<{ center: string; assets: number }>>;

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
    admin = await createActor(dataSource);
    await grant(admin.id, 'INTERNAL_CONTROL_DIRECTOR');
    tokens['admin'] = await token(admin);
    viewer = await createActor(dataSource);
    await grant(viewer.id, 'AUDITOR');
    tokens['viewer'] = await token(viewer);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name) VALUES ($1, 'Estructura') RETURNING id`,
      [`CCS-${randomUUID().slice(0, 6)}`],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('prefijo de unidad: único entre activas; un centro nuevo fuera del rango se rechaza con el rango', async () => {
    const u7 = await createUnit('IT_VICE_SIETE', 'Vicerrectoría de Prueba Siete', '7');
    expect(u7.status).toBe(201);
    expect(u7.body.data).toMatchObject({ codePrefix: '7' });
    ids['u7'] = u7.body.data.id as string;
    const u8 = await createUnit('IT_VICE_OCHO', 'Vicerrectoría de Prueba Ocho', '8');
    expect(u8.status).toBe(201);
    ids['u8'] = u8.body.data.id as string;
    const repeated = await createUnit('IT_VICE_OTRA', 'Otra', '7');
    expect(repeated.status).toBe(409);
    expect(repeated.body.error.code).toBe('ORG_UNIT_CODE_PREFIX_EXISTS');

    const outside = await createCenter({ externalCode: '8100', name: 'Fuera de rango', organizationalUnitId: ids['u7'] });
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('COST_CENTER_CODE_OUT_OF_UNIT_RANGE');
    expect(outside.body.error.message).toBe(
      'Los centros de Vicerrectoría de Prueba Siete van de 7000 a 7999 (el código debe empezar por 7)',
    );

    for (const [key, code, extra] of [
      ['c7100', '7100', {}],
      ['c7200', '7200', { hasMovement: false }],
    ] as const) {
      const created = await createCenter({ externalCode: code, name: `Centro ${code}`, organizationalUnitId: ids['u7'], ...extra });
      expect(created.status).toBe(201);
      ids[key] = created.body.data.id as string;
    }
    const grouping = await http().get(`/api/v1/cost-centers/${ids['c7200']}`).set(auth('admin'));
    expect(grouping.body.data).toMatchObject({ hasMovement: false, acceptsAssets: false });
    const child = await createCenter({ externalCode: '7210', name: 'Centro 7210', organizationalUnitId: ids['u7'], parentId: ids['c7200'] });
    expect(child.status).toBe(201);
    ids['c7210'] = child.body.data.id as string;

    // El alta abre el historial con quién, IP y agente.
    const [opened] = (await dataSource.query(
      `SELECT source, changed_by, host(ip_address) AS ip, user_agent, valid_until FROM cost_center_placement WHERE cost_center_id = $1`,
      [ids['c7100']],
    )) as Array<{ source: string; changed_by: string; ip: string | null; user_agent: string; valid_until: Date | null }>;
    expect(opened).toMatchObject({ source: 'MANUAL', changed_by: admin.id, user_agent: AGENT, valid_until: null });
    expect(opened?.ip).toBeTruthy();
  });

  it('sugiere el siguiente código libre en el rango de la unidad o bajo el padre', async () => {
    const byUnit = await http().get('/api/v1/cost-centers/suggest-code').query({ unitId: ids['u7'] }).set(auth('viewer'));
    expect(byUnit.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/suggest-code', 200, byUnit.body);
    expect(byUnit.body.data).toEqual({
      code: '7300',
      rangeFrom: '7000',
      rangeTo: '7999',
      basis: 'UNIT',
      matchesUnitPrefix: true,
      reason: null,
    });
    const byParent = await http()
      .get('/api/v1/cost-centers/suggest-code')
      .query({ unitId: ids['u8'], parentId: ids['c7200'] })
      .set(auth('viewer'));
    expect(byParent.body.data).toMatchObject({ code: '7211', rangeFrom: '7201', rangeTo: '7299', basis: 'PARENT', matchesUnitPrefix: false });
    const neither = await http().get('/api/v1/cost-centers/suggest-code').set(auth('viewer'));
    expect(neither.status).toBe(400);
  });

  it('cambia la ubicación con historial sin solapes, auditoría con IP y agente, y resuelve a una fecha', async () => {
    const denied = await place(ids['c7100'] ?? '', { organizationalUnitId: ids['u8'], reason: 'Sin permiso' }, 'viewer');
    expect(denied.status).toBe(403);
    const short = await place(ids['c7100'] ?? '', { organizationalUnitId: ids['u8'], reason: 'no' });
    expect(short.status).toBe(400);

    const moved = await place(ids['c7100'] ?? '', { organizationalUnitId: ids['u8'], reason: 'Resolución rectoral 12 de 2026' });
    expect(moved.status).toBe(201);
    expectConforms('post', '/api/v1/cost-centers/{id}/placement', 201, moved.body);
    expect(moved.body.data).toMatchObject({
      organizationalUnit: { id: ids['u8'], codePrefix: '8' },
      parent: null,
      hasMovement: true,
      isCurrent: true,
      validUntil: null,
      source: 'MANUAL',
      reason: 'Resolución rectoral 12 de 2026',
      changedBy: admin.id,
    });
    const same = await place(ids['c7100'] ?? '', { organizationalUnitId: ids['u8'], reason: 'Otra vez lo mismo' });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('COST_CENTER_PLACEMENT_UNCHANGED');
    // La caché de cost_center sigue a la vigente; el código nunca cambia.
    const center = await http().get(`/api/v1/cost-centers/${ids['c7100']}`).set(auth('admin'));
    expect(center.body.data).toMatchObject({ externalCode: '7100', organizationalUnitId: ids['u8'] });

    const [audit] = (await dataSource.query(
      `SELECT host(ip_address) AS ip, user_agent, changes FROM audit_log
       WHERE action = 'COST_CTR_PLACED' AND entity_id = $1 ORDER BY performed_at DESC LIMIT 1`,
      [ids['c7100']],
    )) as Array<{ ip: string | null; user_agent: string; changes: Record<string, unknown> }>;
    expect(audit?.ip).toBeTruthy();
    expect(audit?.user_agent).toBe(AGENT);
    expect(audit?.changes).toMatchObject({ event: 'COST_CENTER_PLACEMENT_CHANGED', source: 'MANUAL' });
    expect(JSON.stringify(audit?.changes)).not.toContain('Resolución');

    // Ninguna ubicación se solapa con otra del mismo centro y hay a lo sumo una vigente por centro.
    expect(
      await scalar<number>(
        dataSource,
        `SELECT count(*)::int FROM cost_center_placement a JOIN cost_center_placement b
           ON a.cost_center_id = b.cost_center_id AND a.id < b.id
          AND tstzrange(a.valid_from, a.valid_until, '[)') && tstzrange(b.valid_from, b.valid_until, '[)')`,
      ),
    ).toBe(0);
    expect(
      await scalar<number>(
        dataSource,
        `SELECT count(*)::int FROM (SELECT cost_center_id FROM cost_center_placement WHERE valid_until IS NULL
           GROUP BY cost_center_id HAVING count(*) > 1) x`,
      ),
    ).toBe(0);
    // Ni escribiendo por fuera del servicio: el EXCLUDE lo impide.
    await expect(
      dataSource.query(
        `INSERT INTO cost_center_placement (cost_center_id, has_movement, valid_from, reason, source)
         VALUES ($1, TRUE, NOW() - interval '1 hour', 'Solape a mano', 'MANUAL')`,
        [ids['c7100']],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23P01' } });

    // Historia con fechas: la inicial del 10 de enero al 1 de marzo, la nueva desde el 1 de marzo.
    const [initial, current] = (await dataSource.query(
      'SELECT id FROM cost_center_placement WHERE cost_center_id = $1 ORDER BY valid_from',
      [ids['c7100']],
    )) as Array<{ id: string }>;
    await dataSource.query(
      `UPDATE cost_center_placement SET valid_from = '2026-01-10T12:00:00-05:00', valid_until = '2026-03-01T08:00:00-05:00' WHERE id = $1`,
      [initial?.id],
    );
    await dataSource.query(`UPDATE cost_center_placement SET valid_from = '2026-03-01T08:00:00-05:00' WHERE id = $1`, [current?.id]);
    const at = (date: string) =>
      http().get(`/api/v1/cost-centers/${ids['c7100']}/placement`).query({ at: date }).set(auth('viewer'));
    const february = await at('2026-02-15');
    expect(february.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/{id}/placement', 200, february.body);
    expect(february.body.data.placement).toMatchObject({ organizationalUnit: { id: ids['u7'] }, isCurrent: false });
    expect((await at('2026-03-15')).body.data.placement).toMatchObject({ organizationalUnit: { id: ids['u8'] }, isCurrent: true });
    // El día del cambio cuenta al final del día (hora de Colombia): ya es la nueva.
    expect((await at('2026-03-01')).body.data.placement).toMatchObject({ organizationalUnit: { id: ids['u8'] } });
    expect((await at('2026-01-09')).body.data.placement).toBeNull();
    expect((await at('2026-02-31')).status).toBe(400);
  });

  it('rechaza ciclos de centro padre y el cambio de padre o unidad por PATCH', async () => {
    const self = await place(ids['c7200'] ?? '', { parentId: ids['c7200'], reason: 'Padre de sí mismo' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('COST_CENTER_PLACEMENT_CYCLE');
    const cycle = await place(ids['c7200'] ?? '', { parentId: ids['c7210'], reason: 'Bajo su propio hijo' });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe('COST_CENTER_PLACEMENT_CYCLE');
    expect(await scalar<string | null>(dataSource, 'SELECT parent_id FROM cost_center WHERE id = $1', [ids['c7200']])).toBeNull();

    const patch = await http().patch(`/api/v1/cost-centers/${ids['c7210']}`).set(auth('admin')).send({ parentId: ids['c7100'] });
    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe('COST_CENTER_PLACEMENT_REQUIRED');
    // Igual al vigente sí se acepta (el formulario puede reenviarlo).
    const unchanged = await http()
      .patch(`/api/v1/cost-centers/${ids['c7210']}`)
      .set(auth('admin'))
      .send({ parentId: ids['c7200'], name: 'Centro 7210 renombrado' });
    expect(unchanged.status).toBe(200);
  });

  it('agrupador: con activos se rechaza (y desactivar también, con el número de activos); sin activos deja de aceptarlos', async () => {
    await insertAsset(`CCS-${randomUUID().slice(0, 6)}`, ids['c7210'] ?? '');
    const blocked = await place(ids['c7210'] ?? '', { hasMovement: false, reason: 'Pasa a agrupar' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({
      code: 'COST_CENTER_GROUPING_HAS_ASSETS',
      details: [{ field: 'activeAssets', message: '1' }],
    });
    const deactivate = await http().delete(`/api/v1/cost-centers/${ids['c7210']}`).set(auth('admin'));
    expect(deactivate.status).toBe(406);
    expect(deactivate.body.error).toMatchObject({
      code: 'COST_CENTER_HAS_ACTIVE_ASSETS',
      message: 'No puede desactivarse: tiene activos asignados',
      details: [{ field: 'activeAssets', message: '1' }],
    });

    const created = await createCenter({ externalCode: '7220', name: 'Centro 7220', organizationalUnitId: ids['u7'] });
    ids['c7220'] = created.body.data.id as string;
    const grouped = await place(ids['c7220'] ?? '', { hasMovement: false, parentId: ids['c7200'], reason: 'Pasa a agrupar' });
    expect(grouped.status).toBe(201);
    const row = await http().get(`/api/v1/cost-centers/${ids['c7220']}`).set(auth('admin'));
    expect(row.body.data).toMatchObject({ hasMovement: false, acceptsAssets: false, parentId: ids['c7200'] });
  });

  it('lista los centros cuyo código no cuadra con su unidad, con el motivo', async () => {
    const response = await http().get('/api/v1/cost-centers/prefix-mismatches').set(auth('viewer'));
    expect(response.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/prefix-mismatches', 200, response.body);
    const mine = (response.body.data as Array<{ id: string; reason: string; expectedUnit: { id: string } | null }>).filter((item) =>
      Object.values(ids).includes(item.id),
    );
    expect(mine).toEqual([
      expect.objectContaining({ id: ids['c7100'], reason: 'CODE_OUT_OF_RANGE', expectedUnit: expect.objectContaining({ id: ids['u7'] }) }),
    ]);
    const unitless = await createCenter({ externalCode: `SIN-UNIDAD-${randomUUID().slice(0, 4)}`, name: 'Sin unidad' });
    const again = await http().get('/api/v1/cost-centers/prefix-mismatches').set(auth('viewer'));
    expect((again.body.data as Array<{ id: string; reason: string }>).find((item) => item.id === unitless.body.data.id)).toMatchObject({
      reason: 'NO_UNIT',
      expectedUnit: null,
    });
  });

  it('historial (ubicaciones y jefaturas juntas) y árbol a una fecha con unidad, movimiento, activos y jefe', async () => {
    const head = await http()
      .post('/api/v1/cost-center-heads')
      .set(auth('admin'))
      .send({ personId: viewer.personId, costCenterId: ids['c7200'], reason: 'Designación de prueba' });
    expect(head.status).toBe(201);

    const history = await http().get(`/api/v1/cost-centers/${ids['c7100']}/history`).set(auth('viewer'));
    expect(history.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/{id}/history', 200, history.body);
    expect((history.body.data.events as Array<{ kind: string; validFrom: string }>).map((event) => [event.kind, event.validFrom.slice(0, 10)])).toEqual([
      ['PLACEMENT', '2026-03-01'],
      ['PLACEMENT', '2026-01-10'],
    ]);
    const headed = await http().get(`/api/v1/cost-centers/${ids['c7200']}/history`).set(auth('viewer'));
    const kinds = (headed.body.data.events as Array<{ kind: string; validFrom: string }>).map((event) => event.kind);
    expect(kinds).toEqual(['HEAD', 'PLACEMENT']);

    const tree = await http().get('/api/v1/cost-centers/tree').set(auth('viewer'));
    expect(tree.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/tree', 200, tree.body);
    type Node = { id: string; hasMovement: boolean; directAssets: number; heads: Array<{ personId: string }>; children: Node[] };
    const root = (tree.body.data.roots as Node[]).find((node) => node.id === ids['c7200']);
    expect(root).toMatchObject({ hasMovement: false, directAssets: 0, heads: [{ personId: viewer.personId }] });
    expect(root?.children.map((node) => node.id).sort()).toEqual([ids['c7210'], ids['c7220']].sort());
    expect(root?.children.find((node) => node.id === ids['c7210'])?.directAssets).toBe(1);

    // En febrero el 7100 estaba en la unidad 7; los centros creados hoy no existían.
    const february = await http().get('/api/v1/cost-centers/tree').query({ at: '2026-02-15' }).set(auth('viewer'));
    const roots = february.body.data.roots as Array<{ id: string; organizationalUnit: { id: string } | null }>;
    expect(roots.find((node) => node.id === ids['c7100'])?.organizationalUnit?.id).toBe(ids['u7']);
    expect(roots.some((node) => node.id === ids['c7200'])).toBe(false);
  });

  describe('reconstrucción por la importación (UPDATE_STRUCTURE) con la forma de la hoja 2025', () => {
    const SHEET: Record<number, Cell[]> = {
      3: [null, null, null, null, 'CCostos'],
      4: [null, null, null, 'Codigo', 'Nombre', 'Movimiento', 'x', 'RESPONSABLE'],
      5: [null, null, null, 1, 'RECTORÍA', 0, '1 RECTORÍA', ' '],
      6: [null, null, null, 1000, 'RECTORÍA', 0, '1000 RECTORÍA', ' '],
      7: [null, null, null, 1010, 'RECTORÍA', 1, '1010 RECTORÍA', 'PERSONA DE PRUEBA'],
      8: [null, null, null, 1100, 'OFICINA JURÍDICA', 0, '1100 OFICINA JURÍDICA', ' '],
      9: [null, null, null, 1110, 'OFICINA JURÍDICA', 1, '1110 OFICINA JURÍDICA', ' '],
      10: [null, null, null, 3000, 'DEPARTAMENTO DE SERVICIOS EDUCATIVOS', 0, '', ' '],
      11: [null, null, null, 3040, 'ACADEMIA DE MÚSICA UNAC', 1, '', ' '],
      12: [null, null, null, 3050, 'UNACTEC', 0, '', ' '],
      13: [null, null, null, 3051, 'TÉCNICA LABORAL SOFTWARE', 1, '', ' '],
      14: [null, null, null, 3052, 'TÉCNICA LABORAL ADMINISTRATIVO', 1, '', ' '],
      15: [null, null, null, 9, 'INSTITUCIONAL', 0, '', ' '],
      16: [null, null, null, 9200, 'DESARROLLO INSTITUCIONAL', 0, '', ' '],
      17: [null, null, null, 9205, 'FONDO PARA EL DESARROLLO DEL PERSONAL', 0, '', ' '],
      18: [null, null, null, 9206, 'FONDO PARA EL DESARROLLO DEL PERSONAL - ADMINISTRATIVO', 1, '', ' '],
      19: [null, null, null, 9207, 'FONDO PARA EL DESARROLLO DEL PERSONAL - FORMACIÓN TECNOLÓGICA', 1, '', ' '],
      20: [null, null, null, 9210, 'FONDO PARA EL FOMENTO DE BIENESTAR UNIV.', 1, '', ' '],
      21: [null, null, null, 9211, 'FONDO PARA EL DESARROLLO DEL PERSONAL - INVESTIGACIÓN', 1, '', ' '],
    };

    const workbook = async (): Promise<Buffer> => {
      const book = new ExcelJS.Workbook();
      const ws = book.addWorksheet('2025');
      for (const [rowNumber, values] of Object.entries(SHEET)) {
        const row = ws.getRow(Number(rowNumber));
        values.forEach((value, index) => {
          if (value !== null) {
            row.getCell(index + 1).value = value;
          }
        });
        row.commit();
      }
      return Buffer.from(await book.xlsx.writeBuffer());
    };

    const code = (external: string) => scalar<string>(dataSource, 'SELECT id FROM cost_center WHERE external_code = $1', [external]);
    const structureOf = async (external: string) => {
      const [row] = (await dataSource.query(
        `SELECT p.external_code AS parent, u.code AS unit, cc.has_movement, cc.accepts_assets, cc.name
         FROM cost_center cc LEFT JOIN cost_center p ON p.id = cc.parent_id
         LEFT JOIN organizational_unit u ON u.id = cc.organizational_unit_id
         WHERE cc.external_code = $1`,
        [external],
      )) as Array<{ parent: string | null; unit: string | null; has_movement: boolean; accepts_assets: boolean; name: string }>;
      return row;
    };

    it('la vista previa cuenta lo que cambia y avisa; la confirmación lo aplica sin mover activos', async () => {
      // Como en la base de staging: centros importados de la hoja 2026 (sin padre ni unidad) con activos.
      for (const [external, name] of [
        ['1010', 'Rectoría'],
        ['1110', 'OFICINA JURÍDICA'],
        ['3040', 'ACADEMIA DE MÚSICA UNAC'],
        ['9206', 'FONDO PARA EL DESARROLLO DEL PERSONAL - ADMINISTRATIVO'],
        ['1120', 'CENTRO QUE NO ESTÁ EN LA HOJA'],
      ] as const) {
        const id = await scalar<string>(
          dataSource,
          `INSERT INTO cost_center (external_code, name, sync_source) VALUES ($1, $2, 'IMPORT_EXCEL') RETURNING id`,
          [external, name],
        );
        await insertAsset(`CCS-${external}-${randomUUID().slice(0, 4)}`, id);
        await insertAsset(`CCS-${external}-${randomUUID().slice(0, 4)}`, id);
      }
      const before = await assetCountsByCenter();
      const imports = app.get(ExcelImportService);
      const upload = await imports.upload(await workbook(), 'centros de costo.xlsx', admin.id);
      expect(upload.sheets[0]).toMatchObject({ name: '2025', detectedHeaderRow: 4 });
      // El operador asigna por error la columna RESPONSABLE a la unidad: se quita del mapeo y se avisa.
      const mapping = { code: 'D', name: 'E', movement: 'F', unitCode: 'H' };

      const outsider = await createActor(dataSource);
      await expect(
        imports.preview(upload.batchId, { sheet: '2025', target: 'COST_CENTERS', mapping, structureMode: 'UPDATE_STRUCTURE' }, outsider.id),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });

      const insertOnly = await imports.preview(upload.batchId, { sheet: '2025', target: 'COST_CENTERS', mapping }, admin.id);
      expect(insertOnly.summary.costCenterStructure).toBeNull();

      const preview = await imports.preview(
        upload.batchId,
        { sheet: '2025', target: 'COST_CENTERS', mapping, structureMode: 'UPDATE_STRUCTURE' },
        admin.id,
      );
      expect(preview.summary).toMatchObject({ rowsRead: 17, toInsert: 13, alreadyPresent: 4, quarantined: {} });
      expect(preview.summary.costCenterStructure).toMatchObject({
        mode: 'UPDATE_STRUCTURE',
        toInsert: 13,
        existingInFile: 4,
        parentChanges: 4,
        unitChanges: 3,
        movementChanges: 0,
        nameDifferences: 1,
        orphans: 1,
        groupingCenters: 8,
        movementCenters: 9,
        unitsToCreate: 2,
        unitsToAssociate: 0,
        groupingWithAssets: 0,
        groupingWithoutChildren: 1,
        prefixesWithoutUnit: ['3'],
      });
      expect(preview.summary.costCenterStructure?.notInFile).toBeGreaterThanOrEqual(1);
      const issues = (await imports.issues(preview.importId, 1, 500)).items.map((issue) => `${issue.code}:${issue.rawValue ?? ''}`);
      expect(issues).toEqual(
        expect.arrayContaining([
          'RESPONSIBLE_NOT_IMPORTED:',
          'NAME_DIFFERS:1010',
          'PARENT_NOT_FOUND:3000',
          'GROUPING_WITHOUT_CHILDREN:9205',
          'PREFIX_WITHOUT_UNIT:3',
          'UNIT_CREATED:1',
          'UNIT_CREATED:9',
        ]),
      );
      // La vista previa no escribe nada.
      expect(await scalar<string | null>(dataSource, `SELECT id FROM cost_center WHERE external_code = '9205'`)).toBeUndefined();

      const result = await app.get(ImportJobsService).runNow(preview.importId, admin.id);
      expect(result).toMatchObject({ inserted: 13, skippedAlreadyPresent: 4 });
      expect(result.costCenterStructure).toMatchObject({ parentChanges: 4, unitChanges: 3, unitsToCreate: 2 });

      expect(await structureOf('1')).toMatchObject({ parent: null, unit: 'CC_1', has_movement: false, accepts_assets: false });
      expect(await structureOf('1000')).toMatchObject({ parent: '1', unit: 'CC_1', has_movement: false });
      expect(await structureOf('1010')).toMatchObject({ parent: '1000', unit: 'CC_1', has_movement: true, name: 'Rectoría' });
      expect(await structureOf('1110')).toMatchObject({ parent: '1100', unit: 'CC_1' });
      expect(await structureOf('3000')).toMatchObject({ parent: null, unit: null, has_movement: false });
      expect(await structureOf('3040')).toMatchObject({ parent: '3000', unit: null });
      expect(await structureOf('3051')).toMatchObject({ parent: '3050', unit: null });
      expect(await structureOf('9205')).toMatchObject({ parent: '9200', unit: 'CC_9', has_movement: false });
      for (const external of ['9206', '9207', '9210', '9211']) {
        expect((await structureOf(external))?.parent).toBe('9200');
      }
      expect(await structureOf('1120')).toMatchObject({ parent: null, unit: null, name: 'CENTRO QUE NO ESTÁ EN LA HOJA' });
      expect(
        await dataSource.query(`SELECT code, name, unit_type, code_prefix FROM organizational_unit WHERE code IN ('CC_1', 'CC_9') ORDER BY code`),
      ).toEqual([
        { code: 'CC_1', name: 'RECTORÍA', unit_type: 'VICERECTORATE', code_prefix: '1' },
        { code: 'CC_9', name: 'INSTITUCIONAL', unit_type: 'VICERECTORATE', code_prefix: '9' },
      ]);

      // Historial: el existente tiene su alta y el cambio por importación (con el lote); el nuevo, su alta por importación.
      const history = (await dataSource.query(
        `SELECT source, staging_import_id, valid_until IS NULL AS current FROM cost_center_placement
         WHERE cost_center_id = $1 ORDER BY valid_from, changed_at`,
        [await code('1010')],
      )) as Array<{ source: string; staging_import_id: string | null; current: boolean }>;
      expect(history).toEqual([
        { source: 'IMPORT', staging_import_id: null, current: false },
        { source: 'IMPORT', staging_import_id: preview.importId, current: true },
      ]);
      expect(
        await dataSource.query(`SELECT source, staging_import_id FROM cost_center_placement WHERE cost_center_id = $1`, [await code('9205')]),
      ).toEqual([{ source: 'IMPORT', staging_import_id: preview.importId }]);

      // Ni un activo cambió de centro.
      expect(await assetCountsByCenter()).toEqual(before);
    });
  });
});
