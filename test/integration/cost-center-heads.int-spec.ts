// Jefatura de centro de costo (HU 1.0.14) y permisos :own con asignación COST_CENTER, por HTTP real contra
// PostgreSQL real.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, scalar, openTestSession } from './helpers.js';

describe('Jefes de centro de costo y permisos :own (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let centerA: string;
  let centerB: string;
  const assetsA: string[] = [];
  const users: Record<string, AuthenticatedUser> = {};
  const tokens: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });
  const listAssets = (who: string) => http().get('/api/v1/assets').query({ pageSize: 100 }).set(auth(who));

  const userWith = async (
    name: string,
    assignments: ReadonlyArray<{ role: string; scopeType: 'GLOBAL' | 'COST_CENTER'; scopeId?: string }>,
  ) => {
    const user = await createActor(dataSource);
    for (const assignment of assignments) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, $2, $3 FROM role WHERE code = $4`,
        [user.id, assignment.scopeType, assignment.scopeId ?? null, assignment.role],
      );
    }
    users[name] = user;
    tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);

    const creator = await createActor(dataSource);
    const tag = randomUUID().slice(0, 6);
    centerA = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro dirigido') RETURNING id`,
      [`HEAD-A-${tag}`],
    );
    centerB = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro ajeno') RETURNING id`,
      [`HEAD-B-${tag}`],
    );
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name) VALUES ($1, 'Jefaturas') RETURNING id`,
      [`HEAD-${tag}`],
    );
    const insertAsset = (code: string, centerId: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
           current_cost_center_id, created_by)
         VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2021-03-01', $4, $5)
         RETURNING id`,
        [code, `Activo ${code}`, categoryId, centerId, creator.id],
      );
    for (let index = 1; index <= 3; index += 1) {
      assetsA.push(await insertAsset(`HEAD-A-${tag}-${index}`, centerA));
    }
    await insertAsset(`HEAD-B-${tag}-1`, centerB);

    await userWith('admin', [{ role: 'INTERNAL_CONTROL_DIRECTOR', scopeType: 'GLOBAL' }]);
    // Rol con asset:read:org_unit asignado GLOBAL: hoy no alcanza ningún centro (SCOPE_NO_COST_CENTER).
    await userWith('jefe', [{ role: 'DEPARTMENT_HEAD', scopeType: 'GLOBAL' }]);
    await userWith('consulta', [{ role: 'VIEWER', scopeType: 'COST_CENTER', scopeId: centerA }]);
    await userWith('sinRol', []);
    await userWith('custodio', [{ role: 'CUSTODIAN', scopeType: 'COST_CENTER', scopeId: centerA }]);
    await userWith('auditor', [{ role: 'AUDITOR', scopeType: 'GLOBAL' }]);
  });

  afterAll(async () => {
    await app.close();
  });

  const assign = (personId: string, who = 'admin', extra: Record<string, unknown> = {}) =>
    http()
      .post('/api/v1/cost-center-heads')
      .set(auth(who))
      .send({ personId, costCenterId: centerA, reason: 'Resolución de rectoría 045', ...extra });

  it('un jefe por relación ve los activos de su centro y deja de verlos al terminar la jefatura (sin esperar la caché)', async () => {
    // Antes: sin asignación COST_CENTER ni jefatura. La consulta llena la caché de permisos.
    const before = await listAssets('jefe');
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('SCOPE_NO_COST_CENTER');

    const created = await assign(users['jefe']?.personId ?? '');
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      personId: users['jefe']?.personId,
      costCenterId: centerA,
      isCurrent: true,
      validUntil: null,
      assignedBy: users['admin']?.id,
      assignedByName: `Integración ${users['admin']?.username.slice(3)}`,
      endedByName: null,
      endedAt: null,
    });
    const headId = created.body.data.id as string;

    const during = await listAssets('jefe');
    expect(during.status).toBe(200);
    expect((during.body.data.items as Array<{ id: string }>).map((item) => item.id).sort()).toEqual([...assetsA].sort());

    const heads = await http().get(`/api/v1/cost-centers/${centerA}/heads`).query({ current: 'true' }).set(auth('admin'));
    expect(heads.status).toBe(200);
    expect((heads.body.data as Array<{ id: string }>).map((item) => item.id)).toEqual([headId]);
    const headships = await http().get(`/api/v1/persons/${users['jefe']?.personId}/cost-center-headships`).set(auth('admin'));
    expect((headships.body.data as Array<{ costCenterId: string }>).map((item) => item.costCenterId)).toEqual([centerA]);

    // Misma persona, mismo centro, período traslapado: 409.
    const overlap = await assign(users['jefe']?.personId ?? '');
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('COST_CENTER_HEAD_OVERLAP');

    const ended = await http().post(`/api/v1/cost-center-heads/${headId}/end`).set(auth('admin')).send({ reason: 'Cambio de cargo' });
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({
      isCurrent: false,
      endedBy: users['admin']?.id,
      endedByName: `Integración ${users['admin']?.username.slice(3)}`,
      endReason: 'Cambio de cargo',
    });

    const after = await listAssets('jefe');
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('SCOPE_NO_COST_CENTER');
    const again = await http().post(`/api/v1/cost-center-heads/${headId}/end`).set(auth('admin')).send({ reason: 'Otra vez' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('COST_CENTER_HEAD_ENDED');

    const audits = await scalar<string>(
      dataSource,
      `SELECT count(*) FROM audit_log WHERE entity_type = 'COST_CENTER_HEAD' AND entity_id = $1`,
      [headId],
    );
    expect(Number(audits)).toBe(2);
  });

  it('nadie se designa jefe a sí mismo: 403 ROLE_SELF_ASSIGNMENT_FORBIDDEN y nada queda escrito', async () => {
    const response = await assign(users['admin']?.personId ?? '');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ROLE_SELF_ASSIGNMENT_FORBIDDEN');
    const rows = await scalar<number>(
      dataSource,
      'SELECT count(*)::int FROM cost_center_head WHERE person_id = $1',
      [users['admin']?.personId],
    );
    expect(rows).toBe(0);
  });

  it('asignar y terminar exigen motivo (3..500) y quedan auditados con IP, user-agent y motivo, visibles en el historial', async () => {
    const person = await createActor(dataSource);
    for (const reason of [undefined, '  ', 'ab', 'x'.repeat(501)]) {
      const invalid = await assign(person.personId, 'admin', { reason });
      expect(invalid.status).toBe(400);
    }
    const created = await assign(person.personId, 'admin').set('User-Agent', 'it-heads/1.0');
    expect(created.status).toBe(201);
    const headId = created.body.data.id as string;
    const noReason = await http().post(`/api/v1/cost-center-heads/${headId}/end`).set(auth('admin')).send({ reason: 'no' });
    expect(noReason.status).toBe(400);
    const ended = await http()
      .post(`/api/v1/cost-center-heads/${headId}/end`)
      .set(auth('admin'))
      .set('User-Agent', 'it-heads/1.0')
      .send({ reason: '  Terminó el encargo  ' });
    expect(ended.status).toBe(200);
    expect(ended.body.data.endReason).toBe('Terminó el encargo');

    const audits = (await dataSource.query(
      `SELECT ip_address::text AS ip, user_agent, changes, performed_by FROM audit_log
       WHERE entity_type = 'COST_CENTER_HEAD' AND entity_id = $1 ORDER BY id`,
      [headId],
    )) as Array<{ ip: string | null; user_agent: string | null; changes: Record<string, unknown>; performed_by: string }>;
    expect(audits.map((row) => row.changes['event'])).toEqual(['COST_CENTER_HEAD_ASSIGNED', 'COST_CENTER_HEAD_ENDED']);
    for (const row of audits) {
      expect(row.ip).not.toBeNull();
      expect(row.user_agent).toBe('it-heads/1.0');
      expect(row.performed_by).toBe(users['admin']?.id);
    }
    expect(audits.map((row) => row.changes['reason'])).toEqual(['Resolución de rectoría 045', 'Terminó el encargo']);

    const history = await http().get(`/api/v1/cost-centers/${centerA}/history`).set(auth('admin'));
    expect(history.status).toBe(200);
    const event = (history.body.data.events as Array<{ kind: string; head: { id: string; reason: string; endReason: string | null } | null }>)
      .find((item) => item.kind === 'HEAD' && item.head?.id === headId);
    const adminName = `Integración ${users['admin']?.username.slice(3)}`;
    expect(event?.head).toMatchObject({
      reason: 'Resolución de rectoría 045',
      endReason: 'Terminó el encargo',
      assignedByName: adminName,
      endedByName: adminName,
    });
  });

  it('varias personas pueden dirigir el mismo centro (no se impone jefe único)', async () => {
    const other = await createActor(dataSource);
    const created = await assign(other.personId);
    expect(created.status).toBe(201);
    const second = await createActor(dataSource);
    expect((await assign(second.personId)).status).toBe(201);
    const heads = await http().get(`/api/v1/cost-centers/${centerA}/heads`).query({ current: 'true' }).set(auth('admin'));
    expect((heads.body.data as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('la jefatura no da permisos: sin un rol con el permiso acotado sigue sin acceso', async () => {
    expect((await assign(users['sinRol']?.personId ?? '')).status).toBe(201);
    const response = await listAssets('sinRol');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('VIEWER con asignación COST_CENTER sigue viendo exactamente su centro', async () => {
    const response = await listAssets('consulta');
    expect(response.status).toBe(200);
    expect((response.body.data.items as Array<{ id: string }>).map((item) => item.id).sort()).toEqual([...assetsA].sort());
  });

  it('asignar y listar jefaturas exige el permiso de administración de centros de costo', async () => {
    expect((await assign(users['consulta']?.personId ?? '', 'consulta')).status).toBe(403);
    expect((await http().get(`/api/v1/cost-centers/${centerA}/heads`).set(auth('consulta'))).status).toBe(403);
    const invalid = await assign(users['consulta']?.personId ?? '', 'admin', {
      validFrom: '2026-10-01T00:00:00.000Z',
      validUntil: '2026-09-01T00:00:00.000Z',
    });
    expect(invalid.status).toBe(400);
  });

  it('leer jefaturas pide solo cost_center:read:global: el AUDITOR las lee y no puede asignar ni terminar', async () => {
    const grants = (await dataSource.query(
      `SELECT p.code FROM role_permission rp JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
       WHERE r.code = 'AUDITOR' AND p.code LIKE 'cost_center:%' ORDER BY p.code`,
    )) as Array<{ code: string }>;
    expect(grants.map((grant) => grant.code)).toEqual(['cost_center:read:global']);

    const heads = await http().get(`/api/v1/cost-centers/${centerA}/heads`).set(auth('auditor'));
    expect(heads.status).toBe(200);
    expect((heads.body.data as unknown[]).length).toBeGreaterThan(0);
    const headships = await http()
      .get(`/api/v1/persons/${users['jefe']?.personId}/cost-center-headships`)
      .set(auth('auditor'));
    expect(headships.status).toBe(200);

    const denied = await assign(users['auditor']?.personId ?? '', 'auditor');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    const anyHead = (heads.body.data as Array<{ id: string }>)[0]?.id ?? '';
    const endDenied = await http().post(`/api/v1/cost-center-heads/${anyHead}/end`).set(auth('auditor')).send({ reason: 'Sin permiso' });
    expect(endDenied.status).toBe(403);
  });

  it(':own con asignación COST_CENTER: el custodio acotado puede solicitar un préstamo, no a nombre de otro', async () => {
    const loan = {
      assets: [assetsA[0]],
      targetCostCenterId: centerB,
      expectedReturnDate: '2030-12-01',
      justification: 'Préstamo para una actividad académica del semestre',
      contactPerson: users['custodio']?.personId,
    };
    const own = await http().post('/api/v1/loans').set(auth('custodio')).send(loan);
    expect(own.status).toBe(201);
    expect(own.body.data.requestedBy).toBe(users['custodio']?.id);

    const onBehalf = await http()
      .post('/api/v1/loans')
      .set(auth('custodio'))
      .send({ ...loan, assets: [assetsA[1]], requestedBy: users['admin']?.id });
    expect(onBehalf.status).toBe(403);
    expect(onBehalf.body.error.code).toBe('OUT_OF_SCOPE');

    // Quien no tiene el permiso :own sigue sin poder pedir.
    const viewer = await http().post('/api/v1/loans').set(auth('consulta')).send({ ...loan, assets: [assetsA[2]] });
    expect(viewer.status).toBe(403);
    expect(viewer.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });
});
