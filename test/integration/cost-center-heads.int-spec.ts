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
import { createActor, scalar } from './helpers.js';

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
    tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: randomUUID() });
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
    expect(ended.body.data).toMatchObject({ isCurrent: false, endedBy: users['admin']?.id, endReason: 'Cambio de cargo' });

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
