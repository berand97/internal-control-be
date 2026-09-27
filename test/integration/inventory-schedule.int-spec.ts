import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { addDays, bogotaDate, reminderDueAt } from '../../src/modules/inventories/domain/inventory-schedule.js';
import { InventoriesService } from '../../src/modules/inventories/services/inventories.service.js';
import { InventoryRemindersService } from '../../src/modules/inventories/services/inventory-reminders.service.js';
import { MailOutboxService } from '../../src/shared/mail/mail-outbox.service.js';
import { MailService } from '../../src/shared/mail/mail.service.js';
import { openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

interface Who {
  readonly personId: string;
  readonly userId: string | null;
  readonly email: string;
  readonly token: string | null;
}

interface Recipient {
  personId: string;
  name: string;
  role: string;
  emailMasked: string | null;
  hasUser: boolean;
  email: boolean;
  inApp: boolean;
}

describe('Programación de tomas físicas: avisos, recordatorios, calendario y cobertura (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let director: Who;
  let directorActor: AuthenticatedUser;
  let responsible: Who;
  let base: { categoryId: string; acquisitionTypeId: string; roomA: string; roomB: string };
  const inventoryIds: string[] = [];
  const today = bogotaDate(new Date());
  const day = (offset: number) => addDays(today, offset);

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${director.token ?? ''}` });

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

  const person = async (first: string, withUser: boolean): Promise<Who> => {
    const tag = randomUUID().slice(0, 8);
    const email = `${first.toLowerCase()}.${tag}@unac.edu.co`;
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ($1, 'Programación', $2) RETURNING id`,
      [first, email],
    );
    if (!withUser) {
      return { personId, userId: null, email, token: null };
    }
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `prog.${tag}`],
    );
    const sessionId = await openTestSession(dataSource, userId);
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `prog.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { personId, userId, email, token };
  };

  const center = (label: string) =>
    scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, $2) RETURNING id`, [
      `IT-P${randomUUID().slice(0, 6)}`,
      label,
    ]);

  const head = (personId: string, costCenterId: string) =>
    dataSource.query(
      `INSERT INTO cost_center_head (person_id, cost_center_id, valid_from, reason)
       VALUES ($1, $2, NOW() - interval '1 day', 'Prueba de programación')`,
      [personId, costCenterId],
    );

  const newAsset = (costCenterId: string, locationId: string) =>
    app.get(AssetsService).create(
      {
        categoryId: base.categoryId,
        costCenterId,
        acquisitionTypeId: base.acquisitionTypeId,
        description: `Programación ${randomUUID().slice(0, 6)}`,
        acquisitionDate: '2021-01-01',
        locationId,
      },
      directorActor,
    );

  const schedule = async (body: Record<string, unknown>) => {
    const response = await http()
      .post('/api/v1/inventories')
      .set(auth())
      .send({ name: 'Toma programada de prueba', responsibleUserId: responsible.userId, ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    inventoryIds.push(response.body.data.id as string);
    return response.body as { data: Record<string, unknown> & { id: string } };
  };

  const outbox = (inventoryId: string, template: string) =>
    dataSource.query(
      `SELECT id, recipient_user_id, recipient_person_id, context FROM mail_outbox
       WHERE entity_type = 'INVENTORY' AND entity_id = $1 AND template_type = $2 ORDER BY created_at`,
      [inventoryId, template],
    ) as Promise<Array<{ id: string; recipient_user_id: string | null; recipient_person_id: string | null; context: Record<string, string> }>>;

  const reminders = (inventoryId: string) =>
    dataSource.query(
      `SELECT offset_days, schedule_rev, status, sent_at, outbox_ids FROM inventory_reminder
       WHERE inventory_id = $1 ORDER BY schedule_rev, offset_days DESC`,
      [inventoryId],
    ) as Promise<Array<{ offset_days: number; schedule_rev: number; status: string; sent_at: Date | null; outbox_ids: string[] }>>;

  beforeAll(async () => {
    process.env['INVENTORY_WEEKLY_CONCENTRATION_THRESHOLD'] = '1';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    // Los crons se detienen: el test decide cuándo corre el worker de recordatorios y el del outbox.
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    director = await person('Directora', true);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.userId],
    );
    directorActor = {
      id: director.userId ?? '',
      personId: director.personId,
      username: 'directora',
      roles: ['INTERNAL_CONTROL_DIRECTOR'],
      scopes: [{ type: 'GLOBAL', id: null }],
      mustChangePassword: false,
    };
    responsible = await person('Responsable', true);
    const campus = await scalar<string>(dataSource, `INSERT INTO campus (code, name) VALUES ('IT-PC', 'Sede programación') RETURNING id`);
    const building = await scalar<string>(
      dataSource,
      `INSERT INTO building (campus_id, code, name) VALUES ($1, 'IT-PB', 'Bloque programación') RETURNING id`,
      [campus],
    );
    const room = (code: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO location (building_id, code, name, location_type) VALUES ($1, $2, $2, 'OFFICE') RETURNING id`,
        [building, code],
      );
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo) VALUES ('IT_PROG', 'Categoría programación', FALSE) RETURNING id`,
      ),
      acquisitionTypeId: await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`),
      roomA: await room('IT-P101'),
      roomB: await room('IT-P102'),
    };
  });

  afterAll(async () => {
    delete process.env['INVENTORY_WEEKLY_CONCENTRATION_THRESHOLD'];
    await app.close();
  });

  it('programar a futuro con dos jefes vigentes: correo a ambos (tengan o no usuario), notificación a quien tiene usuario y al responsable', async () => {
    const centerId = await center('Talento Humano');
    const headUser = await person('Jefa', true);
    const headNoUser = await person('Jefe', false);
    await head(headUser.personId, centerId);
    await head(headNoUser.personId, centerId);

    const created = await schedule({
      scope: 'COST_CENTER',
      scopeId: centerId,
      plannedStartDate: day(40),
      plannedEndDate: day(44),
    });
    expectConforms('post', '/api/v1/inventories', 201, created);
    const data = created.data as unknown as {
      id: string;
      status: string;
      rescheduled: boolean;
      reminderOffsetsDays: number[];
      warnings: unknown[];
      reminders: Array<{ offsetDays: number; status: string }>;
      noticeRecipients: Recipient[];
    };
    expect(data.status).toBe('PLANNED');
    expect(data.rescheduled).toBe(false);
    expect(data.reminderOffsetsDays).toEqual([30, 15, 1]);
    expect(data.warnings).toEqual([]);
    expect(data.reminders.map((item) => [item.offsetDays, item.status])).toEqual([
      [30, 'PENDING'],
      [15, 'PENDING'],
      [1, 'PENDING'],
    ]);
    const byPerson = new Map(data.noticeRecipients.map((item) => [item.personId, item]));
    expect(byPerson.get(headUser.personId)).toMatchObject({ role: 'COST_CENTER_HEAD', email: true, inApp: true, hasUser: true });
    expect(byPerson.get(headNoUser.personId)).toMatchObject({ role: 'COST_CENTER_HEAD', email: true, inApp: false, hasUser: false });
    expect(byPerson.get(responsible.personId)).toMatchObject({ role: 'RESPONSIBLE', email: false, inApp: true });
    expect(byPerson.get(headUser.personId)?.emailMasked).toBe(`j***@unac.edu.co`);
    expect(JSON.stringify(data.noticeRecipients)).not.toContain(headUser.email);

    const mails = await outbox(data.id, 'INVENTORY_SCHEDULED');
    expect(mails.map((mail) => mail.recipient_person_id).sort()).toEqual([headUser.personId, headNoUser.personId].sort());
    expect(mails.every((mail) => mail.recipient_user_id === null)).toBe(true);
    expect(mails[0]?.context['toma.alcance']).toMatch(/^Centro de costo IT-P.* · Talento Humano$/);
    const notified = (await dataSource.query(
      `SELECT recipient_user_id FROM notification WHERE entity_id = $1 AND notification_type = 'INVENTORY_SCHEDULED'`,
      [data.id],
    )) as Array<{ recipient_user_id: string }>;
    expect(notified.map((row) => row.recipient_user_id).sort()).toEqual([headUser.userId, responsible.userId].sort());

    // El correo a la persona sin usuario sale a su person.email.
    const sendTemplated = vi.spyOn(app.get(MailService), 'sendTemplated').mockResolvedValue(true);
    const toPerson = mails.find((mail) => mail.recipient_person_id === headNoUser.personId);
    expect(await app.get(MailOutboxService).dispatchNow(toPerson?.id ?? '')).toBe('SENT');
    expect(sendTemplated).toHaveBeenCalledWith(
      'INVENTORY_SCHEDULED',
      headNoUser.email,
      expect.objectContaining({ 'user.fullName': 'Jefe Programación', 'toma.codigo': expect.any(String) }),
      expect.any(String),
      null,
    );
    sendTemplated.mockRestore();
  });

  it('sin jefe vigente con correo: la toma se programa con advertencia y solo notifica al responsable', async () => {
    const centerId = await center('Sin jefe');
    const code = await scalar<string>(dataSource, 'SELECT external_code FROM cost_center WHERE id = $1', [centerId]);
    const created = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(35), plannedEndDate: day(36) });
    const data = created.data as unknown as { id: string; warnings: Array<{ code: string; message: string }>; noticeRecipients: Recipient[] };
    expect(data.warnings).toEqual([
      {
        code: 'NO_HEAD_WITH_EMAIL',
        message: `El centro ${code} no tiene jefe vigente con correo: el aviso y los recordatorios no llegarán por correo a nadie`,
      },
    ]);
    expect(data.noticeRecipients.map((item) => item.role)).toEqual(['RESPONSIBLE']);
    expect(await outbox(data.id, 'INVENTORY_SCHEDULED')).toEqual([]);
  });

  it('dos tomas del mismo centro: fechas distintas se permiten sin advertencia; fechas cruzadas advierten sin bloquear', async () => {
    const centerId = await center('Solape');
    const first = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(40), plannedEndDate: day(44) });
    const later = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(60), plannedEndDate: day(62) });
    expect((later.data['warnings'] as Array<{ code: string }>).map((item) => item.code)).not.toContain('SCHEDULE_OVERLAP');
    expect(later.data['conflicts']).toEqual([]);
    const crossing = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(44), plannedEndDate: day(50) });
    expect((crossing.data['warnings'] as Array<{ code: string }>).map((item) => item.code)).toContain('SCHEDULE_OVERLAP');
    expect(crossing.data['conflicts']).toEqual([
      expect.objectContaining({ id: first.data.id, reason: 'SAME_SCOPE', status: 'PLANNED' }),
    ]);

    // Una toma por ubicación que comparte activos con el centro también choca (SHARED_ASSETS).
    await newAsset(centerId, base.roomB);
    const byRoom = await schedule({ scope: 'LOCATION', scopeId: base.roomB, plannedStartDate: day(61), plannedEndDate: day(61) });
    expect(byRoom.data['conflicts']).toEqual([expect.objectContaining({ id: later.data.id, reason: 'SHARED_ASSETS' })]);
    expect((byRoom.data['warnings'] as Array<{ code: string }>).map((item) => item.code)).toEqual(
      expect.arrayContaining(['NO_HEAD_FOR_SCOPE', 'SCHEDULE_OVERLAP']),
    );
  });

  it('start sigue prohibiendo dos tomas EN CURSO sobre los mismos activos, pero una PLANNED ya no bloquea el inicio', async () => {
    const centerId = await center('Inicio');
    await newAsset(centerId, base.roomA);
    const first = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(0), plannedEndDate: day(3) });
    const second = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(20), plannedEndDate: day(22) });
    const inventories = app.get(InventoriesService);
    const started = await inventories.start(first.data.id, directorActor);
    expect(started.status).toBe('IN_PROGRESS');
    await expect(inventories.start(second.data.id, directorActor)).rejects.toMatchObject({ code: 'INVENTORY_SCOPE_OVERLAP' });
    expect(await scalar<string>(dataSource, 'SELECT status FROM physical_inventory WHERE id = $1', [second.data.id])).toBe('PLANNED');
  });

  it('programar la próxima semana: los de 30 y 15 días quedan SKIPPED y nunca se envían; el de 1 día sale una vez', async () => {
    const centerId = await center('Próxima semana');
    const headNoUser = await person('Jefatura', false);
    await head(headNoUser.personId, centerId);
    const start = day(7);
    const created = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: start, plannedEndDate: day(8) });
    const data = created.data as unknown as { id: string; warnings: Array<{ code: string; message: string }> };
    expect(data.warnings).toEqual([
      { code: 'REMINDERS_SKIPPED', message: 'Los recordatorios de 30, 15 días antes ya pasaron y no se enviarán' },
    ]);
    expect((await reminders(data.id)).map((row) => [row.offset_days, row.status])).toEqual([
      [30, 'SKIPPED'],
      [15, 'SKIPPED'],
      [1, 'PENDING'],
    ]);

    const worker = app.get(InventoryRemindersService);
    const due = new Date(reminderDueAt(start, 1).getTime() + 60_000);
    await worker.processDue(200, due);
    await worker.processDue(200, due);
    const after = await reminders(data.id);
    expect(after.map((row) => [row.offset_days, row.status])).toEqual([
      [30, 'SKIPPED'],
      [15, 'SKIPPED'],
      [1, 'SENT'],
    ]);
    const mails = await outbox(data.id, 'INVENTORY_REMINDER');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ recipient_person_id: headNoUser.personId, recipient_user_id: null });
    expect(mails[0]?.context['recordatorio.cuando']).toBe('mañana');
    expect(after[2]?.outbox_ids).toEqual([mails[0]?.id]);
  });

  it('el worker es idempotente: dos pasadas concurrentes y una tercera dejan un solo correo por jefe y recordatorio', async () => {
    const centerId = await center('Concurrencia');
    const headA = await person('Ana', true);
    const headB = await person('Beto', false);
    await head(headA.personId, centerId);
    await head(headB.personId, centerId);
    const start = day(20);
    const created = await schedule({
      scope: 'COST_CENTER',
      scopeId: centerId,
      plannedStartDate: start,
      plannedEndDate: day(21),
      reminderOffsetsDays: [15],
    });
    const worker = app.get(InventoryRemindersService);
    const due = new Date(reminderDueAt(start, 15).getTime() + 60_000);
    await Promise.all([worker.processDue(200, due), worker.processDue(200, due), worker.processOne(due)]);
    await worker.processDue(200, due);
    const mails = await outbox(created.data.id, 'INVENTORY_REMINDER');
    expect(mails.map((mail) => mail.recipient_person_id).sort()).toEqual([headA.personId, headB.personId].sort());
    expect((await reminders(created.data.id)).map((row) => row.status)).toEqual(['SENT']);
    const notified = await scalar<string>(
      dataSource,
      `SELECT count(*) FROM notification WHERE entity_id = $1 AND notification_type = 'INVENTORY_REMINDER'`,
      [created.data.id],
    );
    expect(Number(notified)).toBe(2); // jefa con usuario + responsable
  });

  it('reprogramar: los pendientes quedan SUPERSEDED, nacen los de la nueva revisión, se avisa y se audita', async () => {
    const centerId = await center('Reprogramación');
    const headUser = await person('Rita', true);
    await head(headUser.personId, centerId);
    const created = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(40), plannedEndDate: day(42) });
    const id = created.data.id;

    const same = await http()
      .post(`/api/v1/inventories/${id}/reschedule`)
      .set(auth())
      .send({ plannedStartDate: day(40), plannedEndDate: day(42), reason: 'Sin cambio' });
    expect(same.status).toBe(400);
    const past = await http()
      .post(`/api/v1/inventories/${id}/reschedule`)
      .set(auth())
      .send({ plannedStartDate: day(-1), plannedEndDate: day(2), reason: 'Al pasado' });
    expect(past.status).toBe(400);

    const moved = await http()
      .post(`/api/v1/inventories/${id}/reschedule`)
      .set(auth())
      .send({ plannedStartDate: day(50), plannedEndDate: day(53), reason: 'Coincide con el cierre contable' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/reschedule', 200, moved.body);
    expect(moved.body.data).toMatchObject({
      plannedStartDate: day(50),
      plannedEndDate: day(53),
      rescheduled: true,
      rescheduleCount: 1,
      status: 'PLANNED',
    });
    expect((await reminders(id)).map((row) => [row.schedule_rev, row.offset_days, row.status])).toEqual([
      [0, 30, 'SUPERSEDED'],
      [0, 15, 'SUPERSEDED'],
      [0, 1, 'SUPERSEDED'],
      [1, 30, 'PENDING'],
      [1, 15, 'PENDING'],
      [1, 1, 'PENDING'],
    ]);
    const mails = await outbox(id, 'INVENTORY_RESCHEDULED');
    expect(mails).toHaveLength(1);
    expect(mails[0]?.context['toma.motivo']).toBe('Coincide con el cierre contable');
    const audit = (await dataSource.query(
      `SELECT action, changes FROM audit_log WHERE entity_id = $1 AND action = 'INV_RESCHEDULED'`,
      [id],
    )) as Array<{ changes: Record<string, unknown> }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.changes).toMatchObject({ reason: 'Coincide con el cierre contable', rescheduleCount: 1 });

    // Aunque un recordatorio de la revisión vieja volviera a quedar PENDING (carrera con el worker), no sale:
    // su revisión ya no es la vigente y queda SUPERSEDED.
    await dataSource.query(
      `UPDATE inventory_reminder SET status = 'PENDING' WHERE inventory_id = $1 AND schedule_rev = 0 AND offset_days = 30`,
      [id],
    );
    await app.get(InventoryRemindersService).processDue(500, new Date(reminderDueAt(day(40), 30).getTime() + 60_000));
    expect(await outbox(id, 'INVENTORY_REMINDER')).toEqual([]);
    expect((await reminders(id)).find((row) => row.schedule_rev === 0 && row.offset_days === 30)?.status).toBe('SUPERSEDED');
  });

  it('cancelar: guarda el motivo, cancela los pendientes, avisa y ningún recordatorio se envía después', async () => {
    const centerId = await center('Cancelación');
    const headUser = await person('Carla', true);
    await head(headUser.personId, centerId);
    const created = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(38), plannedEndDate: day(39) });
    const id = created.data.id;
    const cancelled = await http()
      .post(`/api/v1/inventories/${id}/cancel`)
      .set(auth())
      .send({ reason: 'Se hará dentro de la toma general de la sede' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/cancel', 200, cancelled.body);
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Se hará dentro de la toma general de la sede',
      cancelledBy: director.userId,
    });
    expect((await reminders(id)).map((row) => row.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
    expect(await outbox(id, 'INVENTORY_CANCELLED')).toHaveLength(1);

    await app.get(InventoryRemindersService).processDue(500, new Date(reminderDueAt(day(38), 0).getTime() + 60_000));
    expect(await outbox(id, 'INVENTORY_REMINDER')).toEqual([]);

    const again = await http().post(`/api/v1/inventories/${id}/cancel`).set(auth()).send({ reason: 'Otra vez' });
    expect(again.body.error.code).toBe('INVALID_STATE');
    const reschedule = await http()
      .post(`/api/v1/inventories/${id}/reschedule`)
      .set(auth())
      .send({ plannedStartDate: day(40), plannedEndDate: day(41), reason: 'Revivir' });
    expect(reschedule.body.error.code).toBe('INVALID_STATE');
  });

  it('calendario: tomas que cruzan la ventana con choques y concentración semanal (umbral configurado), según OpenAPI', async () => {
    const centerId = await center('Calendario');
    const first = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(70), plannedEndDate: day(72) });
    const second = await schedule({ scope: 'COST_CENTER', scopeId: centerId, plannedStartDate: day(72), plannedEndDate: day(73) });
    const response = await http()
      .get('/api/v1/inventories/calendar')
      .query({ from: day(69), to: day(80) })
      .set(auth())
      .expect(200);
    expectConforms('get', '/api/v1/inventories/calendar', 200, response.body);
    const body = response.body.data as {
      weeklyThreshold: number | null;
      items: Array<{ id: string; costCenter: { id: string } | null; conflicts: Array<{ id: string }>; responsible: { id: string; name: string | null } }>;
      weekWarnings: Array<{ count: number; threshold: number; inventoryIds: string[] }>;
    };
    expect(body.weeklyThreshold).toBe(1);
    const mine = body.items.filter((item) => item.id === first.data.id || item.id === second.data.id);
    expect(mine).toHaveLength(2);
    expect(mine[0]?.costCenter?.id).toBe(centerId);
    expect(mine[0]?.responsible).toEqual({ id: responsible.userId, name: 'Responsable Programación' });
    expect(mine.find((item) => item.id === first.data.id)?.conflicts.map((item) => item.id)).toEqual([second.data.id]);
    expect(body.weekWarnings.some((week) => week.inventoryIds.includes(first.data.id) && week.inventoryIds.includes(second.data.id))).toBe(true);
    expect(body.weekWarnings.every((week) => week.count > week.threshold)).toBe(true);

    const tooWide = await http().get('/api/v1/inventories/calendar').query({ from: day(0), to: day(93) }).set(auth());
    expect(tooWide.status).toBe(400);
    const reversed = await http().get('/api/v1/inventories/calendar').query({ from: day(5), to: day(1) }).set(auth());
    expect(reversed.status).toBe(400);
  });

  it('cobertura: nunca revisados primero, luego más días y peor tasa; última toma por ítems esperados; próxima programada; según OpenAPI', async () => {
    const never = await center('Nunca revisado');
    const worse = await center('Peor tasa');
    const better = await center('Mejor tasa');
    await newAsset(never, base.roomA);
    const worseA = await newAsset(worse, base.roomA);
    const worseB = await newAsset(worse, base.roomA);
    const betterA = await newAsset(better, base.roomA);
    const closed = async (costCenterId: string, items: Array<[string, string]>) => {
      const id = await scalar<string>(
        dataSource,
        `INSERT INTO physical_inventory (code, name, scheduled_start_date, scheduled_end_date, status, responsible_user_id,
           created_by, scope_type, scope_id, closed_at, closed_by)
         VALUES ($1, 'Toma cerrada', $2, $2, 'CLOSED', $3, $3, 'COST_CENTER', $4, NOW() - interval '10 days', $3) RETURNING id`,
        [`TF-IT-C${randomUUID().slice(0, 6)}`, day(-12), director.userId, costCenterId],
      );
      for (const [assetId, result] of items) {
        await dataSource.query(
          `INSERT INTO physical_inventory_item (inventory_id, asset_id, verification_result, expected_cost_center_id,
             missing_cause_other)
           VALUES ($1, $2, $3::varchar, $4, CASE WHEN $3::varchar = 'MISSING' THEN 'Faltante de prueba' END)`,
          [id, assetId, result, costCenterId],
        );
      }
      await dataSource.query(
        `INSERT INTO physical_inventory_item (inventory_id, asset_id, verification_result) VALUES ($1, NULL, 'SURPLUS')`,
        [id],
      );
      return id;
    };
    const worseInventory = await closed(worse, [
      [worseA.id, 'FOUND'],
      [worseB.id, 'MISSING'],
    ]);
    await closed(better, [[betterA.id, 'FOUND']]);
    const next = await schedule({ scope: 'COST_CENTER', scopeId: never, plannedStartDate: day(25), plannedEndDate: day(26) });

    const response = await http().get('/api/v1/inventories/coverage').set(auth()).expect(200);
    expectConforms('get', '/api/v1/inventories/coverage', 200, response.body);
    const items = response.body.data.items as Array<{
      costCenter: { id: string };
      activeAssets: number;
      lastInventory: { id: string; status: string } | null;
      lastResult: { expected: number; notFound: number; misplaced: number; unexpected: number | null } | null;
      notFoundRate: number | null;
      daysSinceLast: number | null;
      nextScheduled: { id: string } | null;
    }>;
    const order = items.map((item) => item.costCenter.id).filter((id) => [never, worse, better].includes(id));
    expect(order).toEqual([never, worse, better]);
    const byId = new Map(items.map((item) => [item.costCenter.id, item]));
    expect(byId.get(never)).toMatchObject({ lastInventory: null, lastResult: null, daysSinceLast: null, activeAssets: 1 });
    expect(byId.get(never)?.nextScheduled?.id).toBe(next.data.id);
    expect(byId.get(worse)).toMatchObject({
      activeAssets: 2,
      lastInventory: { id: worseInventory, status: 'CLOSED' },
      lastResult: { expected: 2, notFound: 1, misplaced: 0, unexpected: 1 },
      notFoundRate: 0.5,
      daysSinceLast: 10,
    });
    expect(byId.get(better)).toMatchObject({ notFoundRate: 0, daysSinceLast: 10 });
    expect(response.body.data.costCenters).toBe(items.length);
  });

  it('ni la auditoría ni los logs de avisos guardan correos completos', async () => {
    const rows = (await dataSource.query(
      `SELECT changes::text AS changes FROM audit_log WHERE entity_type = 'INVENTORY' AND entity_id = ANY($1)`,
      [inventoryIds],
    )) as Array<{ changes: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(inventoryIds.length);
    for (const row of rows) {
      expect(row.changes).not.toMatch(/@/);
    }
  });

  it('el outbox exige exactamente un destinatario (usuario o persona)', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO mail_outbox (template_type, recipient_user_id, recipient_person_id, context) VALUES ('INVENTORY_REMINDER', NULL, NULL, '{}')`,
      ),
    ).rejects.toThrow(/chk_mail_outbox_recipient/);
    await expect(
      dataSource.query(
        `INSERT INTO mail_outbox (template_type, recipient_user_id, recipient_person_id, context) VALUES ('INVENTORY_REMINDER', $1, $2, '{}')`,
        [director.userId, director.personId],
      ),
    ).rejects.toThrow(/chk_mail_outbox_recipient/);
  });

  it('el menú trae "Calendario de tomas" con el recurso y el ícono existentes', async () => {
    const [row] = (await dataSource.query(
      `SELECT module, resource, label, required_action, icon FROM navigation_item WHERE path = '/inventories/calendar'`,
    )) as Array<Record<string, string>>;
    expect(row).toEqual({
      module: 'INVENTORY',
      resource: 'physical_inventory',
      label: 'Calendario de tomas',
      required_action: 'read',
      icon: 'clipboard-check',
    });
  });
});
