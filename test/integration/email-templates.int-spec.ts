// Plantillas de correo por bloques (HTTP real + PostgreSQL real): permisos nuevos y su delegación, migración
// texto → bloques sin pérdida, versionado y activación, validación estricta, escape de variables maliciosas, correo
// de prueba y envío multipart por el outbox (sin SMTP queda FAILED y visible), menú sembrado y contrato OpenAPI.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { DEFAULT_EMAIL_DESIGNS } from '../../src/modules/email-templates/domain/email-template-catalog.js';
import { MailOutboxService } from '../../src/shared/mail/mail-outbox.service.js';
import { MailService } from '../../src/shared/mail/mail.service.js';
import { prepareSmtpMessage } from '../../src/shared/mail/smtp-client.js';
import { scalar } from './helpers.js';

interface Schema {
  readonly $ref?: string;
  readonly allOf?: ReadonlyArray<Schema>;
  readonly oneOf?: ReadonlyArray<Schema>;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: ReadonlyArray<unknown>;
  readonly properties?: Record<string, Schema>;
  readonly additionalProperties?: Schema | boolean;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
}

/** Igual que en document-openapi.int-spec, más oneOf (bloques) y additionalProperties (sampleContext). */
const conform = (openapi: OpenAPIObject, value: unknown, schema: Schema, path: string, errors: string[]): void => {
  const components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
  const resolve = (item: Schema): Schema => {
    if (item.$ref) {
      return resolve(components[item.$ref.replace('#/components/schemas/', '')] ?? {});
    }
    const { allOf, ...own } = item;
    if (allOf) {
      return [...allOf.map(resolve), own].reduce<Schema>(
        (merged, part) => ({
          ...merged,
          ...part,
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required ?? []), ...(part.required ?? [])],
          nullable: Boolean(merged.nullable || part.nullable),
        }),
        {},
      );
    }
    return item;
  };
  const resolved = resolve(schema);
  if (value === null) {
    if (!resolved.nullable) {
      errors.push(`${path}: es null y el esquema no lo declara nullable`);
    }
    return;
  }
  if (resolved.oneOf) {
    const matches = resolved.oneOf.filter((option) => {
      const optionErrors: string[] = [];
      conform(openapi, value, option, path, optionErrors);
      return optionErrors.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(`${path}: cumple ${matches.length} opciones de oneOf (se espera 1): ${JSON.stringify(value)}`);
    }
    return;
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} no está en el enum ${JSON.stringify(resolved.enum)}`);
  }
  const type = resolved.type ?? (resolved.properties ? 'object' : undefined);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: se esperaba arreglo`);
      return;
    }
    value.forEach((item, index) => conform(openapi, item, resolved.items ?? {}, `${path}[${index}]`, errors));
    return;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: se esperaba objeto`);
      return;
    }
    const declared = resolved.properties ?? {};
    const extra = typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : null;
    for (const key of Object.keys(value)) {
      if (!(key in declared)) {
        if (extra) {
          conform(openapi, (value as Record<string, unknown>)[key], extra, `${path}.${key}`, errors);
        } else {
          errors.push(`${path}.${key}: la respuesta la trae y el esquema no la declara`);
        }
      }
    }
    for (const key of resolved.required ?? []) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: requerida en el esquema y ausente en la respuesta`);
      }
    }
    for (const [key, property] of Object.entries(declared)) {
      if (key in value) {
        conform(openapi, (value as Record<string, unknown>)[key], property, `${path}.${key}`, errors);
      }
    }
    return;
  }
  const expected: Record<string, (item: unknown) => boolean> = {
    string: (item) => typeof item === 'string',
    integer: (item) => Number.isInteger(item),
    number: (item) => typeof item === 'number',
    boolean: (item) => typeof item === 'boolean',
  };
  if (type && expected[type] && !expected[type](value)) {
    errors.push(`${path}: se esperaba ${type} y llegó ${typeof value}`);
  }
  if (!type && !resolved.enum) {
    errors.push(`${path}: el esquema no declara tipo`);
  }
};

interface Actor {
  readonly userId: string;
  readonly personId: string;
  readonly token: string;
  readonly email: string;
}

const MALICIOUS = `Ana <b>"Mala"</b> <script>alert('x')</script>`;

describe('Plantillas de correo por bloques (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let director: Actor;
  let viewer: Actor;
  let superAdmin: Actor;

  const http = () => request(app.getHttpServer());
  const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[
      method
    ];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  /** Usuario activo con sesión MFA; roles por código y, si se indica, un rol ad hoc (nivel 1) con esos permisos. */
  const createActor = async (
    roles: ReadonlyArray<string>,
    extraPermissions: ReadonlyArray<string> = [],
    options: { readonly email?: string | null } = {},
  ): Promise<Actor> => {
    const tag = randomUUID().slice(0, 8);
    const email = options.email === undefined ? `plantillas.${tag}@unac.edu.co` : options.email;
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Plantillas', $1, $2) RETURNING id`,
      [tag, email],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `plantillas.${tag}`],
    );
    const codes = [...roles];
    if (extraPermissions.length > 0) {
      const code = `IT_MAIL_${tag.toUpperCase()}`;
      await dataSource.query(`INSERT INTO role (code, name, hierarchy_level) VALUES ($1, $1, 1)`, [code]);
      await dataSource.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id FROM role r JOIN permission p ON p.code = ANY($2::text[]) WHERE r.code = $1`,
        [code, extraPermissions],
      );
      codes.push(code);
    }
    for (const code of codes) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [userId, code],
      );
    }
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', NOW())`,
      [sessionId, userId, randomUUID()],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `plantillas.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token, email: email ?? '' };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    // El worker de importaciones también despacha el outbox cada 5 s: se detiene para que el test decida.
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    director = await createActor(['INTERNAL_CONTROL_DIRECTOR']);
    viewer = await createActor(['VIEWER']);
    superAdmin = await createActor(['SUPER_ADMIN']);
  });

  afterAll(async () => {
    await dataSource.query('UPDATE mail_settings SET enabled = FALSE, host = NULL, from_email = NULL');
    await app.close();
  });

  describe('migración 1767225800000', () => {
    it('cada plantilla de texto quedó en párrafos sin perder nada (unidos con línea en blanco = texto original)', async () => {
      const rows = (await dataSource.query(
        `SELECT template_type, body, blocks, placeholders FROM email_template WHERE body IS NOT NULL ORDER BY template_type`,
      )) as Array<{ template_type: string; body: string; blocks: Array<{ type: string; text: string }>; placeholders: string[] }>;
      expect(rows.map((row) => row.template_type)).toEqual([
        'GENERIC_NOTIFICATION',
        'INVENTORY_ALERT',
        'LOAN_STATUS_NOTIFICATION',
        'PASSWORD_RESET',
        'SYSTEM_ALERT',
        'USER_INVITATION',
      ]);
      for (const row of rows) {
        expect(row.blocks.every((block) => block.type === 'paragraph')).toBe(true);
        expect(row.blocks.map((block) => block.text).join('\n\n')).toBe(row.body);
      }
      const invitation = rows.find((row) => row.template_type === 'USER_INVITATION');
      expect(invitation?.blocks).toHaveLength(3);
      expect(invitation?.blocks[1]?.text).toContain('Contraseña temporal: {{auth.temporaryPassword}}');
    });

    it('permisos nuevos con etiqueta en español, solo para INTERNAL_CONTROL_DIRECTOR; SUPER_ADMIN no los tiene', async () => {
      const rows = (await dataSource.query(
        `SELECT p.code, p.module, p.resource_label, p.action,
                COALESCE((SELECT array_agg(r.code ORDER BY r.code) FROM role_permission rp JOIN role r ON r.id = rp.role_id
                          WHERE rp.permission_id = p.id AND r.code NOT LIKE 'IT\\_%'), '{}') AS roles
         FROM permission p WHERE p.resource_type = 'email_template' ORDER BY p.action`,
      )) as Array<{ code: string; module: string; resource_label: string; action: string; roles: string[] }>;
      expect(rows).toEqual([
        { code: 'email_template:manage:global', module: 'SYSTEM', resource_label: 'Plantillas de correo', action: 'manage', roles: ['INTERNAL_CONTROL_DIRECTOR'] },
        { code: 'email_template:read:global', module: 'SYSTEM', resource_label: 'Plantillas de correo', action: 'read', roles: ['INTERNAL_CONTROL_DIRECTOR'] },
      ]);
    });

    it('una sola versión activa por tipo: la BD rechaza una segunda activa', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO email_template (template_type, version, subject, blocks, placeholders, is_active)
           VALUES ('SYSTEM_ALERT', 999, 'x', '[]', '[]', TRUE)`,
        ),
      ).rejects.toThrow(/uq_email_template_active/);
    });
  });

  describe('menú', () => {
    it('"Plantillas de correo" sembrado con ícono mail; lo ve el director y no el viewer ni el superadmin', async () => {
      const row = (await dataSource.query(
        `SELECT module, module_label, resource, label, required_action, sort_order, icon FROM navigation_item WHERE path = '/email-templates'`,
      )) as Array<Record<string, unknown>>;
      expect(row).toEqual([
        { module: 'SYSTEM', module_label: 'Sistema', resource: 'email_template', label: 'Plantillas de correo', required_action: 'read', sort_order: 106, icon: 'mail' },
      ]);
      const menu = async (actor: Actor) =>
        ((await http().get('/api/v1/auth/me').set(auth(actor)).expect(200)).body.data.navigation as Array<{ path: string; icon: string | null }>);
      expect((await menu(director)).find((item) => item.path === '/email-templates')).toMatchObject({ icon: 'mail' });
      expect((await menu(viewer)).find((item) => item.path === '/email-templates')).toBeUndefined();
      expect((await menu(superAdmin)).find((item) => item.path === '/email-templates')).toBeUndefined();
    });
  });

  describe('permisos', () => {
    it('director sí; viewer y superadmin reciben 403; las rutas viejas /mail/templates ya no existen', async () => {
      const catalog = await http().get('/api/v1/email-templates/catalog').set(auth(director)).expect(200);
      expectConforms('get', '/api/v1/email-templates/catalog', 200, catalog.body);
      expect(catalog.body.data.types).toHaveLength(8);
      expect(catalog.body.data.blocks.map((block: { type: string }) => block.type)).toEqual([
        'heading', 'paragraph', 'button', 'divider', 'keyValueList', 'callout', 'spacer',
      ]);
      for (const actor of [viewer, superAdmin]) {
        const denied = await http().get('/api/v1/email-templates/catalog').set(auth(actor));
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      }
      expect((await http().get('/api/v1/mail/templates/catalog').set(auth(director))).status).toBe(404);
    });

    it('el director delega solo lectura a un rol inferior (cascada); ese rol lee pero no guarda; el superadmin no puede conceder lo que no tiene', async () => {
      // Seed: el director no administra roles; aquí se simula que un superadmin le delegó role:create/manage.
      const delegator = await createActor(['INTERNAL_CONTROL_DIRECTOR'], ['role:create:global', 'role:manage:global']);
      const readId = await scalar<string>(dataSource, `SELECT id FROM permission WHERE code = 'email_template:read:global'`);
      const code = `IT_LECTOR_CORREO_${randomUUID().slice(0, 6).toUpperCase()}`;
      const created = await http()
        .post('/api/v1/roles')
        .set(auth(delegator))
        .send({ code, name: 'Lector de plantillas de correo', permissionIds: [readId] });
      expect(created.status).toBe(201);
      expect(created.body.data.hierarchyLevel).toBeGreaterThan(1);

      const reader = await createActor([code]);
      expect((await http().get('/api/v1/email-templates/catalog').set(auth(reader))).status).toBe(200);
      expect((await http().get('/api/v1/email-templates?templateType=USER_INVITATION').set(auth(reader))).status).toBe(200);
      const design = DEFAULT_EMAIL_DESIGNS.SYSTEM_ALERT;
      const write = await http()
        .post('/api/v1/email-templates')
        .set(auth(reader))
        .send({ templateType: 'SYSTEM_ALERT', subject: design.subject, blocks: design.blocks });
      expect(write.status).toBe(403);

      const superWithRoles = await createActor(['SUPER_ADMIN']);
      const refused = await http()
        .post('/api/v1/roles')
        .set(auth(superWithRoles))
        .send({ code: `${code}_SA`, name: 'Intento del superadmin', permissionIds: [readId] });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('PERMISSION_NOT_HELD');
    });
  });

  describe('versionado, validación y vista previa', () => {
    it('guardar crea la versión siguiente activa; activar una anterior deja una sola activa', async () => {
      const before = await http().get('/api/v1/email-templates?templateType=GENERIC_NOTIFICATION').set(auth(director)).expect(200);
      expectConforms('get', '/api/v1/email-templates', 200, before.body);
      const previous = before.body.data as Array<{ id: string; version: number; isActive: boolean }>;
      expect(previous.filter((row) => row.isActive)).toHaveLength(1);
      const design = DEFAULT_EMAIL_DESIGNS.GENERIC_NOTIFICATION;
      const created = await http()
        .post('/api/v1/email-templates')
        .set(auth(director))
        .send({ templateType: 'GENERIC_NOTIFICATION', subject: design.subject, blocks: design.blocks })
        .expect(201);
      expectConforms('post', '/api/v1/email-templates', 201, created.body);
      expect(created.body.data).toMatchObject({
        version: Math.max(...previous.map((row) => row.version)) + 1,
        isActive: true,
        createdBy: director.userId,
        activatedBy: director.userId,
      });
      expect(created.body.data.placeholders).toEqual(
        expect.arrayContaining(['notification.title', 'app.name', 'user.email', 'notification.message', 'app.loginUrl']),
      );

      const oldest = previous.at(-1);
      const activated = await http()
        .post(`/api/v1/email-templates/${oldest?.id}/activate`)
        .set(auth(director))
        .expect(200);
      expectConforms('post', '/api/v1/email-templates/{id}/activate', 200, activated.body);
      expect(activated.body.data).toMatchObject({ id: oldest?.id, isActive: true, createdBy: null, activatedBy: director.userId });
      const after = await http().get('/api/v1/email-templates?templateType=GENERIC_NOTIFICATION').set(auth(director)).expect(200);
      const active = (after.body.data as Array<{ id: string; isActive: boolean }>).filter((row) => row.isActive);
      expect(active.map((row) => row.id)).toEqual([oldest?.id]);

      const catalog = await http().get('/api/v1/email-templates/catalog').set(auth(director)).expect(200);
      const type = (catalog.body.data.types as Array<{ templateType: string; activeVersion: number | null }>).find(
        (item) => item.templateType === 'GENERIC_NOTIFICATION',
      );
      expect(type?.activeVersion).toBe(oldest?.version);
      expect(
        (catalog.body.data.types as Array<{ templateType: string; activeVersion: number | null }>).find(
          (item) => item.templateType === 'SIGNATURE_LINK',
        )?.activeVersion,
      ).toBeNull();
    });

    it('rechaza bloques fuera del catálogo, variables ajenas u obligatorias faltantes y URL no https', async () => {
      const post = (body: unknown) => http().post('/api/v1/email-templates').set(auth(director)).send(body as object);
      const html = await post({
        templateType: 'SYSTEM_ALERT',
        subject: '{{alert.title}}',
        blocks: [{ type: 'html', html: '<script>alert(1)</script>{{alert.message}}' }],
      });
      expect(html.status).toBe(400);
      expect(html.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(html.body.error.details).toEqual([expect.objectContaining({ field: 'blocks[0].type' })]);

      const url = await post({
        templateType: 'SYSTEM_ALERT',
        subject: '{{alert.title}}',
        blocks: [{ type: 'paragraph', text: '{{alert.message}}' }, { type: 'button', label: 'Ir', url: 'javascript:alert(1)' }],
      });
      expect(url.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(url.body.error.details).toEqual([expect.objectContaining({ field: 'blocks[1].url' })]);

      const unknown = await post({
        templateType: 'SYSTEM_ALERT',
        subject: '{{alert.title}}',
        blocks: [{ type: 'paragraph', text: '{{alert.message}} {{auth.temporaryPassword}}' }],
      });
      expect(unknown.body.error.code).toBe('EMAIL_TEMPLATE_UNKNOWN_VARIABLE');

      const missing = await post({
        templateType: 'PASSWORD_RESET',
        subject: 'Sin enlace',
        blocks: [{ type: 'paragraph', text: 'Hola {{user.email}}' }],
      });
      expect(missing.body.error.code).toBe('EMAIL_TEMPLATE_MISSING_VARIABLE');
      expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'auth.resetUrl' })]);

      const extraField = await post({ templateType: 'SYSTEM_ALERT', subject: 'x', blocks: [], body: 'texto' });
      expect(extraField.status).toBe(400);
      expect(extraField.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('la vista previa devuelve HTML con layout institucional y texto, sin guardar ni enviar', async () => {
      const outboxBefore = await scalar<string>(dataSource, 'SELECT count(*)::text FROM mail_outbox');
      const versionsBefore = await scalar<string>(dataSource, 'SELECT count(*)::text FROM email_template');
      const design = DEFAULT_EMAIL_DESIGNS.USER_INVITATION;
      const preview = await http()
        .post('/api/v1/email-templates/preview')
        .set(auth(director))
        .send({ templateType: 'USER_INVITATION', subject: design.subject, blocks: design.blocks })
        .expect(200);
      expectConforms('post', '/api/v1/email-templates/preview', 200, preview.body);
      expect(preview.body.data.subject).toBe('Invitación a Control Interno UNAC');
      expect(preview.body.data.html).toContain('Control Interno UNAC</span>');
      expect(preview.body.data.html).toContain('href="http://localhost:4200/auth/login"');
      expect(preview.body.data.text).toContain('Contraseña temporal: Temp.Ejemplo1');
      expect(await scalar<string>(dataSource, 'SELECT count(*)::text FROM mail_outbox')).toBe(outboxBefore);
      expect(await scalar<string>(dataSource, 'SELECT count(*)::text FROM email_template')).toBe(versionsBefore);

      const versions = await http().get('/api/v1/email-templates?templateType=USER_INVITATION').set(auth(director)).expect(200);
      const saved = await http()
        .get(`/api/v1/email-templates/${versions.body.data[0].id}/preview`)
        .set(auth(director))
        .expect(200);
      expectConforms('get', '/api/v1/email-templates/{id}/preview', 200, saved.body);
      expect(saved.body.data.text).toContain('Usuario: juliana.perez@unac.edu.co');
    });
  });

  describe('envío por el outbox', () => {
    it('sin SMTP, el correo de prueba queda FAILED con el motivo y visible', async () => {
      await dataSource.query('UPDATE mail_settings SET enabled = FALSE');
      const sent = await http()
        .post('/api/v1/email-templates/test-send')
        .set(auth(director))
        .send({ templateType: 'PASSWORD_RESET' })
        .expect(200);
      expectConforms('post', '/api/v1/email-templates/test-send', 200, sent.body);
      expect(sent.body.data).toMatchObject({
        status: 'FAILED',
        lastError: 'El correo saliente (SMTP) no está configurado o está deshabilitado',
        to: director.email,
        templateId: expect.any(String),
      });
      const row = (await dataSource.query(
        `SELECT recipient_user_id, entity_type, template_version_id, delivery_status, send_attempts FROM mail_outbox WHERE id = $1`,
        [sent.body.data.outboxId],
      )) as Array<Record<string, unknown>>;
      expect(row).toEqual([
        {
          recipient_user_id: director.userId,
          entity_type: 'email_template_test',
          template_version_id: sent.body.data.templateId,
          delivery_status: 'FAILED',
          send_attempts: 1,
        },
      ]);
      expect((await http().post('/api/v1/email-templates/test-send').set(auth(viewer)).send({ templateType: 'PASSWORD_RESET' })).status).toBe(403);
    });

    it('con SMTP listo, el outbox envía texto + HTML; una variable maliciosa llega escapada; la prueba usa la versión pedida', async () => {
      await dataSource.query(
        `UPDATE mail_settings SET enabled = TRUE, host = 'smtp.unac.test', port = 587, from_email = 'noreply@unac.edu.co', from_name = NULL, username = NULL, password = NULL`,
      );
      const mail = app.get(MailService);
      const captured: Array<{ to: string; subject: string; text: string; html?: string }> = [];
      const spy = vi
        .spyOn(mail as unknown as { dispatch: (...args: unknown[]) => Promise<void> }, 'dispatch')
        .mockImplementation((_row: unknown, to: unknown, subject: unknown, text: unknown, html: unknown) => {
          captured.push({ to: to as string, subject: subject as string, text: text as string, ...(html ? { html: html as string } : {}) });
          return Promise.resolve();
        });
      try {
        const outbox = app.get(MailOutboxService);
        const id = await dataSource.transaction((manager) =>
          outbox.enqueue(manager, {
            templateType: 'GENERIC_NOTIFICATION',
            recipientUserId: director.userId,
            context: {
              'user.email': director.email,
              'notification.title': 'Aviso',
              'notification.message': MALICIOUS,
              'app.name': 'Control Interno UNAC',
              'app.loginUrl': 'javascript:alert(1)',
            },
            entityType: 'it_email_templates',
            entityId: null,
          }),
        );
        expect(await outbox.dispatchNow(id)).toBe('SENT');
        expect(await outbox.stateOf(id)).toMatchObject({ status: 'SENT', lastError: null });
        const delivered = captured.at(-1);
        expect(delivered?.to).toBe(director.email);
        expect(delivered?.html).toContain('Ana &lt;b&gt;&quot;Mala&quot;&lt;/b&gt; &lt;script&gt;');
        expect(delivered?.html).not.toContain('<script');
        // El enlace malicioso queda como texto escapado del párrafo migrado, nunca como href.
        expect(delivered?.html).not.toMatch(/href="javascript:/i);
        expect(delivered?.text).toContain(MALICIOUS);

        // Lo que ese correo escribe en el socket: multipart/alternative con ambas partes.
        const message = prepareSmtpMessage({
          from: 'noreply@unac.edu.co',
          to: delivered?.to ?? '',
          subject: delivered?.subject ?? '',
          text: delivered?.text ?? '',
          html: delivered?.html ?? '',
          host: 'x',
          port: 587,
          secure: false,
        });
        expect(message.payload).toMatch(/Content-Type: multipart\/alternative; boundary="=_ci_[0-9a-f]{24}"/);
        expect(message.payload).toContain('Content-Type: text/plain; charset=utf-8');
        expect(message.payload).toContain('Content-Type: text/html; charset=utf-8');

        // Correo de prueba de una versión que NO es la activa: sale esa versión.
        const versions = await http().get('/api/v1/email-templates?templateType=SYSTEM_ALERT').set(auth(director)).expect(200);
        const custom = await http()
          .post('/api/v1/email-templates')
          .set(auth(director))
          .send({
            templateType: 'SYSTEM_ALERT',
            subject: 'Versión de prueba: {{alert.title}}',
            blocks: [{ type: 'heading', text: '{{alert.title}}' }, { type: 'callout', tone: 'warning', text: '{{alert.message}}' }],
          })
          .expect(201);
        await http().post(`/api/v1/email-templates/${versions.body.data[0].id}/activate`).set(auth(director)).expect(200);
        const test = await http()
          .post('/api/v1/email-templates/test-send')
          .set(auth(director))
          .send({ templateType: 'SYSTEM_ALERT', templateId: custom.body.data.id })
          .expect(200);
        expect(test.body.data).toMatchObject({ status: 'SENT', lastError: null, templateId: custom.body.data.id });
        expect(captured.at(-1)?.subject).toBe('Versión de prueba: Servicio interrumpido');
        expect(captured.at(-1)?.html).toContain('El almacenamiento no responde.');

        // Una versión de otro tipo no se acepta.
        const wrong = await http()
          .post('/api/v1/email-templates/test-send')
          .set(auth(director))
          .send({ templateType: 'PASSWORD_RESET', templateId: custom.body.data.id });
        expect(wrong.status).toBe(404);
      } finally {
        spy.mockRestore();
        await dataSource.query('UPDATE mail_settings SET enabled = FALSE');
      }
    });

    it('los llamadores de siempre siguen enviando: invitación y restablecimiento van con HTML', async () => {
      await dataSource.query(
        `UPDATE mail_settings SET enabled = TRUE, host = 'smtp.unac.test', port = 587, from_email = 'noreply@unac.edu.co'`,
      );
      const mail = app.get(MailService);
      const captured: Array<{ subject: string; html?: string }> = [];
      const spy = vi
        .spyOn(mail as unknown as { dispatch: (...args: unknown[]) => Promise<void> }, 'dispatch')
        .mockImplementation((_row: unknown, _to: unknown, subject: unknown, _text: unknown, html: unknown) => {
          captured.push({ subject: subject as string, ...(html ? { html: html as string } : {}) });
          return Promise.resolve();
        });
      try {
        expect(await mail.sendUserInvitation('nueva.persona@unac.edu.co', 'nueva.persona', 'Temp.Real9', { roleName: 'Consulta' })).toBe(true);
        expect(captured.at(-1)?.html).toContain('Temp.Real9');
        expect(await mail.sendPasswordReset('nueva.persona@unac.edu.co', 'tok123')).toBe(true);
        expect(captured.at(-1)?.html).toContain('/auth/reset-password?token=tok123');
        expect(
          await mail.sendSigningLink('nueva.persona@unac.edu.co', {
            url: 'http://localhost:4200/firmar/abc',
            expiresAt: 'mañana',
            formatName: 'OCI-01-55',
            number: '0001',
            signerName: 'Nueva Persona',
            roleLabel: 'Recibe',
            contact: 'Control Interno',
          }),
        ).toBe(true);
        expect(captured.at(-1)?.subject).toBe('Firma pendiente: OCI-01-55 N.° 0001');
        expect(captured.at(-1)?.html).toContain('href="http://localhost:4200/firmar/abc"');
      } finally {
        spy.mockRestore();
        await dataSource.query('UPDATE mail_settings SET enabled = FALSE');
      }
    });
  });
});
