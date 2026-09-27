// Plantillas de correo por bloques (HTTP real + PostgreSQL real): permisos nuevos y su delegación, migración
// texto → bloques sin pérdida, versionado y activación, validación estricta, escape de variables maliciosas, correo
// de prueba y envío multipart por el outbox (sin SMTP queda FAILED y visible), menú sembrado y contrato OpenAPI.
// Párrafo enriquecido (documento Tiptap de esquema cerrado) e imágenes subidas servidas por un endpoint público.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource, type QueryRunner } from 'typeorm';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { EmailTemplatesSuperAdmin1767225810000 } from '../../src/database/migrations/1767225810000-email-templates-super-admin.js';
import {
  EmailRichParagraphAndAssets1767225820000,
  docToText,
} from '../../src/database/migrations/1767225820000-email-rich-paragraph-and-assets.js';
import { EmailAssetImagesPrefix1767225830000 } from '../../src/database/migrations/1767225830000-email-asset-images-prefix.js';
import { EmailLinkVariablesAsLinks1767225840000 } from '../../src/database/migrations/1767225840000-email-link-variables-as-links.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { FeatureFlagsService } from '../../src/modules/features/services/feature-flags.service.js';
import { DEFAULT_EMAIL_DESIGNS } from '../../src/modules/email-templates/domain/email-template-catalog.js';
import { textToRichText } from '../../src/modules/email-templates/domain/rich-text.js';
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
      )) as Array<{ template_type: string; body: string; blocks: Array<{ type: string; content: Parameters<typeof docToText>[0] }>; placeholders: string[] }>;
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
        // 1767225820000 los pasó a documento; volver a texto da el cuerpo original.
        expect(row.blocks.map((block) => docToText(block.content)).join('\n\n')).toBe(row.body);
      }
      const invitation = rows.find((row) => row.template_type === 'USER_INVITATION');
      expect(invitation?.blocks).toHaveLength(3);
      expect(docToText(invitation?.blocks[1]?.content ?? { type: 'doc' })).toContain('Contraseña temporal: {{auth.temporaryPassword}}');
    });

    it('1767225820000: ningún párrafo queda con text; down() los devuelve a texto y up() otra vez al mismo documento', async () => {
      const snapshot = async (runner: QueryRunner) =>
        (await runner.query(`SELECT template_type, version, blocks FROM email_template ORDER BY template_type, version`)) as Array<{
          blocks: Array<Record<string, unknown>>;
        }>;
      const before = (await dataSource.query(
        `SELECT template_type, version, blocks FROM email_template ORDER BY template_type, version`,
      )) as Array<{ blocks: Array<Record<string, unknown>> }>;
      expect(before.length).toBeGreaterThan(0);
      for (const row of before) {
        for (const block of row.blocks.filter((item) => item['type'] === 'paragraph')) {
          expect(Object.keys(block).sort()).toEqual(['content', 'type']);
        }
      }
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        // Orden real de un revert: primero 1767225840000 (sus versiones tienen enlaces, que down() de 1767225820000
        // pierde, documentado), luego 1767225820000; y de vuelta en orden inverso.
        const links = new EmailLinkVariablesAsLinks1767225840000();
        await links.down(runner);
        const migration = new EmailRichParagraphAndAssets1767225820000();
        await migration.down(runner);
        const down = await snapshot(runner);
        for (const row of down) {
          for (const block of row.blocks.filter((item) => item['type'] === 'paragraph')) {
            expect(Object.keys(block).sort()).toEqual(['text', 'type']);
          }
        }
        expect(await runner.query(`SELECT to_regclass('email_asset') AS t`)).toEqual([{ t: null }]);
        await migration.up(runner);
        await links.up(runner);
        expect(await snapshot(runner)).toEqual(before);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('1767225830000: el CHECK acepta images/email/ y email-assets/; down() falla si hay claves nuevas y si no, restaura', async () => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      const insert = (key: string) =>
        runner.query(
          `INSERT INTO email_asset (id, storage_key, public_url, mime, byte_size, width, height, sha256, original_name, created_by)
           VALUES ($1, $2, 'https://cdn.test/x', 'image/png', 1, 1, 1, $3, 'x.png', NULL)`,
          [key.split('/').at(-1)?.slice(0, 36), key, createHash('sha256').update(key).digest('hex')],
        );
      const rejected = async (key: string) => {
        await runner.query('SAVEPOINT chk');
        await expect(insert(key)).rejects.toMatchObject({ constraint: 'chk_email_asset_storage_key' });
        await runner.query('ROLLBACK TO SAVEPOINT chk');
      };
      try {
        const migration = new EmailAssetImagesPrefix1767225830000();
        const fresh = `images/email/${randomUUID()}.png`;
        await insert(fresh);
        await insert(`email-assets/${randomUUID()}.jpg`);
        await rejected(`images/otra/${randomUUID()}.png`);
        await rejected(`documents/${randomUUID()}.png`);

        await expect(migration.down(runner)).rejects.toThrow(/imagen\(es\) de correo usan claves images\/email\//);
        await runner.query('DELETE FROM email_asset WHERE storage_key LIKE $1', ['images/email/%']);
        await migration.down(runner);
        await rejected(`images/email/${randomUUID()}.png`);
        await insert(`email-assets/${randomUUID()}.png`);

        await migration.up(runner);
        await insert(`images/email/${randomUUID()}.jpg`);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('1767225840000: la versión activa con un URL como texto pasa a vN+1 con enlaces; la anterior queda intacta; down() y up()', async () => {
      type Row = {
        template_type: string;
        version: number;
        is_active: boolean;
        created_by: string | null;
        activated_by: string | null;
        activated: boolean;
        has_body: boolean;
        subject: string;
        placeholders: string[];
        blocks: Array<{ type: string; content: { content: Array<{ content?: Array<Record<string, unknown>> }> } }>;
      };
      const seeded = async (runner: QueryRunner | DataSource) =>
        (await runner.query(
          `SELECT template_type, version, is_active, created_by, activated_by, activated_at IS NOT NULL AS activated,
                  body IS NOT NULL AS has_body, subject, placeholders, blocks
           FROM email_template WHERE created_by IS NULL ORDER BY template_type, version`,
        )) as Row[];
      const shape = (rows: Row[]) => rows.map((row) => `${row.template_type} v${row.version}${row.is_active ? ' activa' : ''}`);
      const after = await seeded(dataSource);
      expect(shape(after)).toEqual([
        'GENERIC_NOTIFICATION v1',
        'GENERIC_NOTIFICATION v2 activa',
        'INVENTORY_ALERT v1',
        'INVENTORY_ALERT v2 activa',
        'LOAN_STATUS_NOTIFICATION v1',
        'LOAN_STATUS_NOTIFICATION v2 activa',
        'PASSWORD_RESET v1',
        'PASSWORD_RESET v2 activa',
        'SYSTEM_ALERT v1 activa',
        'USER_INVITATION v1',
        'USER_INVITATION v2 activa',
      ]);
      for (const row of after.filter((item) => item.version === 2)) {
        const previous = after.find((item) => item.template_type === row.template_type && item.version === 1);
        expect(row).toMatchObject({ created_by: null, activated_by: null, activated: true, has_body: false });
        expect(row.subject).toBe(previous?.subject);
        expect(row.placeholders).toEqual(previous?.placeholders);
        // La v1 sigue siendo el texto original (historial sin tocar); la v2 ya no muestra el URL.
        expect(previous?.has_body).toBe(true);
        expect(JSON.stringify(previous?.blocks)).toMatch(/"text": ?"[^"]*\{\{(auth\.loginUrl|auth\.resetUrl|app\.loginUrl)\}\}/);
        expect(JSON.stringify(row.blocks)).not.toMatch(/"text": ?"[^"]*\{\{(auth\.loginUrl|auth\.resetUrl|app\.loginUrl)\}\}/);
      }
      const reset = after.find((row) => row.template_type === 'PASSWORD_RESET' && row.version === 2);
      expect(reset?.blocks[1]?.content.content[0]?.content).toEqual([
        { type: 'text', text: 'Use este enlace para restablecer su contraseña:' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Restablecer contraseña', marks: [{ type: 'link', attrs: { href: '{{auth.resetUrl}}' } }] },
      ]);
      // Las versiones nuevas pasan la validación que aplica el editor.
      const versions = await http().get('/api/v1/email-templates?templateType=PASSWORD_RESET').set(auth(director)).expect(200);
      const active = (versions.body.data as Array<{ isActive: boolean; subject: string; blocks: unknown }>).find((row) => row.isActive);
      await http()
        .post('/api/v1/email-templates/preview')
        .set(auth(director))
        .send({ templateType: 'PASSWORD_RESET', subject: active?.subject, blocks: active?.blocks })
        .expect(200);

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const migration = new EmailLinkVariablesAsLinks1767225840000();
        // Una versión guardada por una persona con el mismo contenido NO la borra down().
        await runner.query(
          `INSERT INTO email_template (template_type, version, subject, blocks, placeholders, is_active, created_by)
           SELECT template_type, 50, subject, blocks, placeholders, FALSE, $1 FROM email_template
           WHERE template_type = 'PASSWORD_RESET' AND version = 2`,
          [director.userId],
        );
        await migration.down(runner);
        expect(shape(await seeded(runner))).toEqual([
          'GENERIC_NOTIFICATION v1 activa',
          'INVENTORY_ALERT v1 activa',
          'LOAN_STATUS_NOTIFICATION v1 activa',
          'PASSWORD_RESET v1 activa',
          'SYSTEM_ALERT v1 activa',
          'USER_INVITATION v1 activa',
        ]);
        expect(await runner.query(`SELECT version FROM email_template WHERE template_type = 'PASSWORD_RESET' AND created_by IS NOT NULL`)).toEqual([
          { version: 50 },
        ]);
        await runner.query(`DELETE FROM email_template WHERE version = 50`);
        await migration.up(runner);
        const again = await seeded(runner);
        expect(shape(again)).toEqual(shape(after));
        expect(again.map((row) => row.blocks)).toEqual(after.map((row) => row.blocks));
        await migration.up(runner);
        expect(shape(await seeded(runner))).toEqual(shape(after));
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('permisos nuevos con etiqueta en español, para INTERNAL_CONTROL_DIRECTOR y (1767225810000) SUPER_ADMIN', async () => {
      const rows = (await dataSource.query(
        `SELECT p.code, p.module, p.resource_label, p.action,
                COALESCE((SELECT array_agg(r.code ORDER BY r.code) FROM role_permission rp JOIN role r ON r.id = rp.role_id
                          WHERE rp.permission_id = p.id AND r.code NOT LIKE 'IT\\_%'), '{}') AS roles
         FROM permission p WHERE p.resource_type = 'email_template' ORDER BY p.action`,
      )) as Array<{ code: string; module: string; resource_label: string; action: string; roles: string[] }>;
      expect(rows).toEqual([
        { code: 'email_template:manage:global', module: 'SYSTEM', resource_label: 'Plantillas de correo', action: 'manage', roles: ['INTERNAL_CONTROL_DIRECTOR', 'SUPER_ADMIN'] },
        { code: 'email_template:read:global', module: 'SYSTEM', resource_label: 'Plantillas de correo', action: 'read', roles: ['INTERNAL_CONTROL_DIRECTOR', 'SUPER_ADMIN'] },
      ]);
    });

    it('1767225810000: down() retira los permisos solo de SUPER_ADMIN y up() es idempotente', async () => {
      const holders = async (runner: QueryRunner) =>
        (
          (await runner.query(
            `SELECT r.code || ' ' || p.code AS grant FROM role_permission rp
             JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
             WHERE p.resource_type = 'email_template' AND r.code NOT LIKE 'IT\\_%' ORDER BY 1`,
          )) as Array<{ grant: string }>
        ).map((row) => row.grant);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const migration = new EmailTemplatesSuperAdmin1767225810000();
        await migration.down(runner);
        expect(await holders(runner)).toEqual([
          'INTERNAL_CONTROL_DIRECTOR email_template:manage:global',
          'INTERNAL_CONTROL_DIRECTOR email_template:read:global',
        ]);
        await migration.up(runner);
        await migration.up(runner);
        expect(await holders(runner)).toEqual([
          'INTERNAL_CONTROL_DIRECTOR email_template:manage:global',
          'INTERNAL_CONTROL_DIRECTOR email_template:read:global',
          'SUPER_ADMIN email_template:manage:global',
          'SUPER_ADMIN email_template:read:global',
        ]);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
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
    it('"Plantillas de correo" sembrado con ícono mail; lo ven el director y el superadmin, no el viewer', async () => {
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
      expect((await menu(superAdmin)).find((item) => item.path === '/email-templates')).toMatchObject({ icon: 'mail' });
    });

    it('con el módulo Correo apagado, /auth/me no sirve el ítem y la API responde MODULE_UNAVAILABLE', async () => {
      const flags = app.get(FeatureFlagsService);
      const menu = async (actor: Actor) =>
        ((await http().get('/api/v1/auth/me').set(auth(actor)).expect(200)).body.data.navigation as Array<{ path: string }>);
      await flags.setEnabled('mail', false);
      try {
        expect((await menu(director)).find((item) => item.path === '/email-templates')).toBeUndefined();
        const blocked = await http().get('/api/v1/email-templates/catalog').set(auth(director));
        expect(blocked.status).toBe(503);
        expect(blocked.body.error.code).toBe('MODULE_UNAVAILABLE');
      } finally {
        await flags.setEnabled('mail', true);
      }
      expect((await menu(director)).find((item) => item.path === '/email-templates')).toBeDefined();
    });
  });

  describe('permisos', () => {
    it('director y superadmin sí; viewer recibe 403; las rutas viejas /mail/templates ya no existen', async () => {
      const catalog = await http().get('/api/v1/email-templates/catalog').set(auth(director)).expect(200);
      expectConforms('get', '/api/v1/email-templates/catalog', 200, catalog.body);
      expect(catalog.body.data.types).toHaveLength(12);
      expect(catalog.body.data.blocks.map((block: { type: string }) => block.type)).toEqual([
        'heading', 'paragraph', 'button', 'divider', 'keyValueList', 'callout', 'spacer', 'image',
      ]);
      expect(catalog.body.data.blocks.find((block: { type: string }) => block.type === 'paragraph').fields).toEqual([
        expect.objectContaining({ name: 'content', kind: 'richText', maxLength: 2000, allowsVariables: true }),
      ]);
      expect(catalog.body.data.imageAligns).toEqual(['left', 'center']);
      expect(catalog.body.data.limits).toMatchObject({ paragraphMaxNodes: 200, maxImages: 10, imageMinWidth: 50, imageMaxWidth: 560 });
      const reset = (catalog.body.data.types as Array<{ templateType: string; required: string[]; optional: string[]; variables: Array<Record<string, unknown>> }>).find(
        (item) => item.templateType === 'PASSWORD_RESET',
      );
      expect(reset?.variables).toEqual([
        { name: 'user.email', label: 'Correo del usuario', kind: 'text', linkText: null },
        { name: 'auth.resetUrl', label: 'Enlace para restablecer la contraseña', kind: 'url', linkText: 'Restablecer contraseña' },
        { name: 'user.username', label: 'Usuario con el que inicia sesión', kind: 'text', linkText: null },
        { name: 'auth.expiresInHours', label: 'Horas de validez del enlace', kind: 'text', linkText: null },
        { name: 'app.name', label: 'Nombre de la aplicación', kind: 'text', linkText: null },
      ]);
      for (const type of catalog.body.data.types as Array<{ required: string[]; optional: string[]; variables: Array<{ name: string }> }>) {
        expect(type.variables.map((item) => item.name)).toEqual([...type.required, ...type.optional]);
      }
      const variableSchema = (openapi.components?.schemas ?? {})['EmailTemplateVariableDto'] as Schema;
      expect(variableSchema.properties?.['linkText']).toMatchObject({ type: 'string', nullable: true });
      expect((openapi.components?.schemas ?? {})['EmailTemplateVariableKind']).toMatchObject({ enum: ['url', 'text'] });
      const superCatalog = await http().get('/api/v1/email-templates/catalog').set(auth(superAdmin)).expect(200);
      expectConforms('get', '/api/v1/email-templates/catalog', 200, superCatalog.body);
      const denied = await http().get('/api/v1/email-templates/catalog').set(auth(viewer));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((await http().get('/api/v1/mail/templates/catalog').set(auth(director))).status).toBe(404);
    });

    it('el director delega solo lectura a un rol inferior (cascada); ese rol lee pero no guarda; el superadmin también la concede; quien administra roles sin tenerla no', async () => {
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

      // 1767225810000: SUPER_ADMIN ya tiene email_template:*, así que puede concederlo.
      const superWithRoles = await createActor(['SUPER_ADMIN']);
      const granted = await http()
        .post('/api/v1/roles')
        .set(auth(superWithRoles))
        .send({ code: `${code}_SA`, name: 'Lector concedido por el superadmin', permissionIds: [readId] });
      expect(granted.status).toBe(201);

      // Quien administra roles pero no tiene email_template:* no puede concederlo.
      const roleAdminOnly = await createActor([], ['role:create:global', 'role:manage:global']);
      const refused = await http()
        .post('/api/v1/roles')
        .set(auth(roleAdminOnly))
        .send({ code: `${code}_RA`, name: 'Intento sin el permiso', permissionIds: [readId] });
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
        blocks: [{ type: 'paragraph', content: textToRichText('{{alert.message}}') }, { type: 'button', label: 'Ir', url: 'javascript:alert(1)' }],
      });
      expect(url.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(url.body.error.details).toEqual([expect.objectContaining({ field: 'blocks[1].url' })]);

      const unknown = await post({
        templateType: 'SYSTEM_ALERT',
        subject: '{{alert.title}}',
        blocks: [{ type: 'paragraph', content: textToRichText('{{alert.message}} {{auth.temporaryPassword}}') }],
      });
      expect(unknown.body.error.code).toBe('EMAIL_TEMPLATE_UNKNOWN_VARIABLE');

      const missing = await post({
        templateType: 'PASSWORD_RESET',
        subject: 'Sin enlace',
        blocks: [{ type: 'paragraph', content: textToRichText('Hola {{user.email}}') }],
      });
      expect(missing.body.error.code).toBe('EMAIL_TEMPLATE_MISSING_VARIABLE');
      expect(missing.body.error.details).toEqual([expect.objectContaining({ field: 'auth.resetUrl' })]);

      // Párrafo: el texto plano de antes, HTML o atributos que Tiptap agrega por defecto se rechazan con la ruta exacta.
      const legacy = await post({ templateType: 'SYSTEM_ALERT', subject: '{{alert.title}}', blocks: [{ type: 'paragraph', text: '{{alert.message}}' }] });
      expect(legacy.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(legacy.body.error.details.map((item: { field: string }) => item.field)).toEqual(['blocks[0].text', 'blocks[0].content']);
      const tiptapDefaults = await post({
        templateType: 'SYSTEM_ALERT',
        subject: '{{alert.title}}',
        blocks: [
          {
            type: 'paragraph',
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { textAlign: null },
                  content: [
                    {
                      type: 'text',
                      text: '{{alert.message}}',
                      marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)', target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }],
                    },
                  ],
                },
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'x' }] },
              ],
            },
          },
        ],
      });
      expect(tiptapDefaults.status).toBe(400);
      expect(tiptapDefaults.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(tiptapDefaults.body.error.details.map((item: { field: string }) => item.field)).toEqual([
        'blocks[0].content.content[0].attrs',
        'blocks[0].content.content[0].content[0].marks[0].attrs.target',
        'blocks[0].content.content[0].content[0].marks[0].attrs.rel',
        'blocks[0].content.content[0].content[0].marks[0].attrs.class',
        'blocks[0].content.content[0].content[0].marks[0].attrs.href',
        'blocks[0].content.content[1].type',
      ]);
      const unknownImage = await post({
        templateType: 'SYSTEM_ALERT',
        subject: '{{alert.title}}',
        blocks: [
          { type: 'paragraph', content: textToRichText('{{alert.message}}') },
          { type: 'image', assetId: randomUUID(), alt: 'No existe', align: 'left' },
        ],
      });
      expect(unknownImage.body.error).toMatchObject({
        code: 'EMAIL_TEMPLATE_INVALID_DESIGN',
        details: [{ field: 'blocks[1].assetId', message: 'La imagen no existe; súbala de nuevo' }],
      });

      const extraField = await post({ templateType: 'SYSTEM_ALERT', subject: 'x', blocks: [], body: 'texto' });
      expect(extraField.status).toBe(400);
      expect(extraField.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('una variable de enlace como texto se rechaza al guardar y al previsualizar con la ruta exacta; como enlace sí', async () => {
      const versionsBefore = await scalar<string>(dataSource, `SELECT count(*)::text FROM email_template WHERE template_type = 'PASSWORD_RESET'`);
      const asText = {
        templateType: 'PASSWORD_RESET',
        subject: 'Restablecer contraseña',
        blocks: [
          { type: 'paragraph', content: textToRichText('Hola {{user.email}},\n\nUse este enlace:\n{{auth.resetUrl}}') },
          { type: 'keyValueList', items: [{ label: 'Enlace', value: '{{auth.resetUrl}}' }] },
        ],
      };
      const expected = [
        { field: 'blocks[0].content.content[1].content[2].text', message: 'Use la variable {{auth.resetUrl}} como enlace o botón, no como texto' },
        { field: 'blocks[1].items[0].value', message: 'Use la variable {{auth.resetUrl}} como enlace o botón, no como texto' },
      ];
      const saved = await http().post('/api/v1/email-templates').set(auth(director)).send(asText);
      expect(saved.status).toBe(400);
      expect(saved.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(saved.body.error.details).toEqual(expected);
      const previewed = await http().post('/api/v1/email-templates/preview').set(auth(director)).send(asText);
      expect(previewed.status).toBe(400);
      expect(previewed.body.error.code).toBe('EMAIL_TEMPLATE_INVALID_DESIGN');
      expect(previewed.body.error.details).toEqual(expected);
      expect(await scalar<string>(dataSource, `SELECT count(*)::text FROM email_template WHERE template_type = 'PASSWORD_RESET'`)).toBe(
        versionsBefore,
      );

      const asLink = await http()
        .post('/api/v1/email-templates/preview')
        .set(auth(director))
        .send({
          templateType: 'PASSWORD_RESET',
          subject: 'Restablecer contraseña',
          blocks: [
            {
              type: 'paragraph',
              content: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Hola {{user.email}}, use este enlace:' },
                      { type: 'hardBreak' },
                      { type: 'text', text: 'Restablecer contraseña', marks: [{ type: 'link', attrs: { href: '{{auth.resetUrl}}' } }] },
                    ],
                  },
                ],
              },
            },
          ],
        })
        .expect(200);
      expect(asLink.body.data.html).toMatch(/<a href="http:\/\/localhost:4200\/auth\/reset-password\?token=ejemplo"[^>]*>Restablecer contraseña<\/a>/);
      expect(asLink.body.data.text).toContain('Restablecer contraseña (http://localhost:4200/auth/reset-password?token=ejemplo)');
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

  describe('imágenes y párrafo enriquecido', () => {
    const png = (width: number, height: number, color = { r: 48, g: 105, b: 153 }) =>
      sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
    const upload = (actor: Actor | null, file: Buffer, name: string, contentType: string) => {
      const req = http().post('/api/v1/email-templates/assets');
      return (actor ? req.set(auth(actor)) : req).attach('file', file, { filename: name, contentType });
    };
    const assetId = randomUUID();
    const PUBLIC_URL = `https://minio-api.unac.test/control-interno-public/email-assets/${assetId}.png`;

    beforeAll(async () => {
      // Imagen ya subida (la subida real a MinIO se prueba en s3-minio.int-spec.ts): solo metadatos y URL pública.
      await dataSource.query(
        `INSERT INTO email_asset (id, storage_key, public_url, mime, byte_size, width, height, sha256, original_name, created_by)
         VALUES ($1, $2, $3, 'image/png', 2048, 1200, 240, $4, 'logo.png', $5)`,
        [assetId, `email-assets/${assetId}.png`, PUBLIC_URL, createHash('sha256').update(assetId).digest('hex'), director.userId],
      );
    });

    it('sin almacenamiento S3 con bucket público: 409 PUBLIC_ASSETS_NOT_CONFIGURED y no se guarda nada (nunca en la BD)', async () => {
      const before = await scalar<string>(dataSource, 'SELECT count(*)::text FROM email_asset');
      const response = await upload(director, await png(300, 60), 'logo.png', 'image/png');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PUBLIC_ASSETS_NOT_CONFIGURED');
      // 3000 × 1500 px ya no se rechaza por tamaño: pasa la validación y llega al almacenamiento (aquí, sin S3).
      const wide = await upload(director, await png(3000, 1500), 'ancha.png', 'image/png');
      expect(wide.status).toBe(409);
      expect(wide.body.error.code).toBe('PUBLIC_ASSETS_NOT_CONFIGURED');
      expect(await scalar<string>(dataSource, 'SELECT count(*)::text FROM email_asset')).toBe(before);
      const columns = (await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'email_asset' ORDER BY ordinal_position`,
      )) as Array<{ column_name: string }>;
      expect(columns.map((column) => column.column_name)).toEqual([
        'id', 'storage_key', 'public_url', 'mime', 'byte_size', 'width', 'height', 'sha256', 'original_name', 'created_by', 'created_at',
      ]);
      const status = await http().get('/api/v1/storage/status').set(auth(superAdmin));
      if (status.status === 200) {
        expect(status.body.data).toMatchObject({ s3PublicAssetsBucket: null, s3PublicAssetsBaseUrl: null });
      }
    });

    it('permisos: lectura, viewer y sin sesión no suben; la lista usa el contrato', async () => {
      const file = await png(300, 60);
      const reader = await createActor([], ['email_template:read:global']);
      const readOnly = await upload(reader, file, 'x.png', 'image/png');
      expect(readOnly.status).toBe(403);
      expect(readOnly.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((await upload(viewer, file, 'x.png', 'image/png')).status).toBe(403);
      expect((await upload(null, file, 'x.png', 'image/png')).status).toBe(401);

      const listed = await http().get('/api/v1/email-templates/assets?limit=5').set(auth(reader)).expect(200);
      expectConforms('get', '/api/v1/email-templates/assets', 200, listed.body);
      expect(listed.body.data).toContainEqual(
        expect.objectContaining({ id: assetId, url: PUBLIC_URL, mime: 'image/png', width: 1200, height: 240, byteSize: 2048 }),
      );
      expect((await http().get('/api/v1/email-templates/assets?limit=101').set(auth(reader))).status).toBe(400);
    });

    it('rechaza por los bytes antes de tocar el almacenamiento: SVG, GIF y HTML renombrados; más de 1 MB; más de 100 megapíxeles; dañada', async () => {
      const svg = await upload(director, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png', 'image/png');
      expect(svg.status).toBe(400);
      expect(svg.body.error).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED', message: 'Solo se admiten imágenes PNG o JPEG' });
      const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).gif().toBuffer();
      expect((await upload(director, gif, 'anim.jpg', 'image/jpeg')).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const html = await upload(director, Buffer.from('<!DOCTYPE html><p>hola</p>'), 'foto.jpg', 'image/jpeg');
      expect(html.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const big = await upload(director, Buffer.alloc(1024 * 1024 + 1, 0x41), 'grande.png', 'image/png');
      expect(big.status).toBe(400);
      expect(big.body.error).toMatchObject({ code: 'FILE_TOO_LARGE', message: 'El archivo supera el máximo de 1 MB' });
      // Más de 100 megapíxeles en 318 KB (un solo color): bomba de descompresión, se rechaza sin decodificarla.
      const bomb = await sharp({ create: { width: 10240, height: 10240, channels: 3, background: '#306999' } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      expect(bomb.length).toBeLessThan(1024 * 1024);
      const huge = await upload(director, bomb, 'enorme.png', 'image/png');
      expect(huge.status).toBe(400);
      expect(huge.body.error).toMatchObject({
        code: 'EMAIL_ASSET_INVALID_IMAGE',
        message: 'La imagen es demasiado grande para procesarla (más de 100 megapíxeles)',
      });
      const broken = await upload(director, (await png(40, 20)).subarray(0, 40), 'rota.png', 'image/png');
      expect(broken.body.error).toMatchObject({ code: 'EMAIL_ASSET_INVALID_IMAGE', message: 'La imagen está dañada o no se puede leer' });
      const noFile = await http().post('/api/v1/email-templates/assets').set(auth(director)).field('x', '1');
      expect(noFile.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    it('el backend ya no sirve imágenes: /public/email-assets/:id no existe', async () => {
      expect((await http().get(`/api/v1/public/email-assets/${assetId}`)).status).toBe(404);
    });

    it('guardar, previsualizar y enviar una versión con párrafo enriquecido e imagen', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Alerta: ', marks: [{ type: 'bold' }] },
              { type: 'text', text: '{{alert.title}}', marks: [{ type: 'italic' }, { type: 'underline' }] },
              { type: 'hardBreak' },
              { type: 'text', text: 'Portal', marks: [{ type: 'link', attrs: { href: 'https://www.unac.edu.co/portal' } }] },
            ],
          },
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{alert.message}}' }] }] }],
          },
        ],
      };
      const blocks = [
        { type: 'image', assetId: assetId.toUpperCase(), alt: 'Logo de {{app.name}}', align: 'center', width: 300, href: 'https://www.unac.edu.co' },
        { type: 'paragraph', content },
      ];
      const saved = await http()
        .post('/api/v1/email-templates')
        .set(auth(director))
        .send({ templateType: 'SYSTEM_ALERT', subject: 'Rica: {{alert.title}}', blocks })
        .expect(201);
      expectConforms('post', '/api/v1/email-templates', 201, saved.body);
      expect(saved.body.data.blocks[0]).toEqual({ ...blocks[0], assetId });
      expect(saved.body.data.blocks[1]).toEqual({ type: 'paragraph', content });
      expect(saved.body.data.placeholders).toEqual(['alert.title', 'app.name', 'alert.message']);
      const listed = await http().get('/api/v1/email-templates?templateType=SYSTEM_ALERT').set(auth(director)).expect(200);
      expectConforms('get', '/api/v1/email-templates', 200, listed.body);

      const src = PUBLIC_URL;
      const expectedImage = `<a href="https://www.unac.edu.co" target="_blank" rel="noopener" style="text-decoration:none;"><img src="${src}" alt="Logo de Control Interno UNAC" width="300" height="60" border="0" style="display:block;width:300px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;margin:0 auto;"></a>`;
      const preview = await http()
        .post('/api/v1/email-templates/preview')
        .set(auth(director))
        .send({ templateType: 'SYSTEM_ALERT', subject: 'Rica: {{alert.title}}', blocks })
        .expect(200);
      expectConforms('post', '/api/v1/email-templates/preview', 200, preview.body);
      expect(preview.body.data.html).toContain(expectedImage);
      expect(preview.body.data.html).toContain('<strong>Alerta: </strong><em><u>Servicio interrumpido</u></em><br><a href="https://www.unac.edu.co/portal"');
      expect(preview.body.data.html).toContain('<li style="margin:0;">El almacenamiento no responde.</li></ul>');
      expect(preview.body.data.text).toContain('[Imagen: Logo de Control Interno UNAC] (https://www.unac.edu.co)');
      expect(preview.body.data.text).toContain('Alerta: Servicio interrumpido\nPortal (https://www.unac.edu.co/portal)\n\n- El almacenamiento no responde.');
      const savedPreview = await http().get(`/api/v1/email-templates/${saved.body.data.id}/preview`).set(auth(director)).expect(200);
      expect(savedPreview.body.data.html).toBe(preview.body.data.html);

      await dataSource.query(
        `UPDATE mail_settings SET enabled = TRUE, host = 'smtp.unac.test', port = 587, from_email = 'noreply@unac.edu.co'`,
      );
      const mail = app.get(MailService);
      const captured: Array<{ html?: string; text: string }> = [];
      const spy = vi
        .spyOn(mail as unknown as { dispatch: (...args: unknown[]) => Promise<void> }, 'dispatch')
        .mockImplementation((_row: unknown, _to: unknown, _subject: unknown, text: unknown, html: unknown) => {
          captured.push({ text: text as string, ...(html ? { html: html as string } : {}) });
          return Promise.resolve();
        });
      try {
        const sent = await http()
          .post('/api/v1/email-templates/test-send')
          .set(auth(director))
          .send({ templateType: 'SYSTEM_ALERT', templateId: saved.body.data.id })
          .expect(200);
        expect(sent.body.data).toMatchObject({ status: 'SENT', templateId: saved.body.data.id });
        expect(captured.at(-1)?.html).toContain(expectedImage);
        expect(captured.at(-1)?.html).toContain('<strong>Alerta: </strong>');
        expect(captured.at(-1)?.text).toContain('[Imagen: Logo de Control Interno UNAC]');
      } finally {
        spy.mockRestore();
        await dataSource.query('UPDATE mail_settings SET enabled = FALSE');
      }
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
