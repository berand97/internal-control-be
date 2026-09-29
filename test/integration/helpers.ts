import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import type { DocumentFormatCatalogService } from '../../src/modules/documents/services/document-format-catalog.service.js';
import { FeaturesModule } from '../../src/modules/features/features.module.js';

export const bootModules = async (
  ...modules: ReadonlyArray<Type<unknown>>
): Promise<TestingModule> => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      DatabaseModule,
      TypeOrmModule.forFeature([...(dataSourceConfig.options.entities as Type<unknown>[])]),
      FeaturesModule,
      ...modules,
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
};

export const createActor = async (
  dataSource: DataSource,
): Promise<AuthenticatedUser> => {
  const tag = randomUUID().slice(0, 8);
  const [person] = (await dataSource.query(
    `INSERT INTO person (first_name, last_name, email)
     VALUES ('Integración', $1, $2) RETURNING id`,
    [tag, `it.${tag}@unac.edu.co`],
  )) as Array<{ id: string }>;
  const [user] = (await dataSource.query(
    `INSERT INTO app_user (person_id, username, password_hash)
     VALUES ($1, $2, 'x') RETURNING id`,
    [person?.id, `it.${tag}`],
  )) as Array<{ id: string }>;
  return {
    id: user?.id ?? '',
    personId: person?.id ?? '',
    username: `it.${tag}`,
    roles: ['INTERNAL_CONTROL_DIRECTOR'],
    scopes: [{ type: 'GLOBAL', id: null }],
    mustChangePassword: false,
  };
};

export const scalar = async <T>(
  dataSource: DataSource,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T> => {
  const rows = (await dataSource.query(sql, [...params])) as Array<Record<string, T>>;
  const row = rows[0] ?? {};
  return Object.values(row)[0] as T;
};

export const SHARED_STORAGE_DIR = join(tmpdir(), 'control-interno-it-storage');

export const useSharedStorage = async (dataSource: DataSource): Promise<string> => {
  await mkdir(SHARED_STORAGE_DIR, { recursive: true });
  await dataSource.query('UPDATE storage_settings SET driver = $1, project_path = $2', ['project', SHARED_STORAGE_DIR]);
  return SHARED_STORAGE_DIR;
};

/**
 * Formato libre de prueba (clave IT-…): con código SGC y los firmantes de un acta de dos turnos (RESPONSABLE =
 * RESPONSIBLE, AUDITA = REQUEST), sin plantilla y sin proceso enchufado. Para las pruebas del motor que necesitan un
 * formato "de nadie": los institucionales sembrados ya pertenecen a un proceso (OCI-21-37 → tomas físicas).
 * Borrarlo con dropTestFormat después de borrar sus actas.
 */
export const createFreeTestFormat = async (
  catalog: DocumentFormatCatalogService,
  key: string,
  actorId: string | null,
): Promise<string> => {
  await catalog.createFormat(
    {
      key,
      sgcCode: `PRUEBA-${key.slice(-8)}`,
      sgcVersion: '1',
      name: `Formato libre de prueba ${key}`,
      signers: [
        { order: 1, role: 'RESPONSABLE', label: 'Responsable', source: 'RESPONSIBLE' },
        { order: 2, role: 'AUDITA', label: 'Control Interno', source: 'REQUEST' },
      ],
      numbering: { width: 5, perYear: false, lastIssued: 0 },
      readPermission: 'inventory:read:global',
      generatePermission: 'inventory:execute:global',
    },
    actorId,
  );
  return key;
};

export const dropTestFormat = async (dataSource: DataSource, key: string): Promise<void> => {
  await dataSource.query('DELETE FROM document_request WHERE format_key = $1', [key]);
  await dataSource.query('DELETE FROM document_template_version WHERE format_key = $1', [key]);
  await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [key]);
  await dataSource.query('DELETE FROM document_format_version WHERE format_key = $1', [key]);
  await dataSource.query('DELETE FROM document_format WHERE key = $1', [key]);
};

/**
 * Aprobar una conciliación encola el acta OCI-21-37 (outbox). Los archivos que concilian tomas la descartan al
 * terminar: processPending procesa toda la cola y otros archivos cuentan exactamente lo que generan.
 */
export const discardInventoryActRequests = async (dataSource: DataSource): Promise<void> => {
  await dataSource.query(
    `UPDATE physical_inventory SET act_request_id = NULL
     WHERE act_request_id IN (SELECT id FROM document_request WHERE status <> 'GENERATED' AND payload->>'entityType' = 'PHYSICAL_INVENTORY')`,
  );
  await dataSource.query(
    `DELETE FROM document_request WHERE status <> 'GENERATED' AND payload->>'entityType' = 'PHYSICAL_INVENTORY'`,
  );
};

/**
 * Abre una sesión real (familia de refresh ACTIVE) para un usuario de prueba y devuelve su id, que va en el claim
 * sid del access token. Desde BE-09 el guard JWT exige que esa sesión exista y siga activa.
 */
export const openTestSession = async (
  dataSource: DataSource,
  userId: string,
  options: { readonly mfaVerified?: boolean } = {},
): Promise<string> => {
  const sessionId = randomUUID();
  await dataSource.query(
    `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
     VALUES ($1, $2, $3, NOW() + interval '1 day', CASE WHEN $4::boolean THEN NOW() END)`,
    [sessionId, userId, randomUUID(), options.mfaVerified === true],
  );
  return sessionId;
};

/** Motivo que exigen los otorgamientos y retiros de roles y permisos (3..500). */
export const GRANT_REASON = 'Motivo de prueba de integración';

const GRANT_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['post', /^\/roles$/],
  ['patch', /^\/roles\/[^/]+$/],
  ['post', /^\/roles\/[^/]+\/permissions$/],
  ['put', /^\/roles\/[^/]+\/permissions$/],
  ['delete', /^\/roles\/[^/]+\/permissions\/[^/]+$/],
  ['post', /^\/users\/[^/]+\/roles$/],
  ['delete', /^\/users\/[^/]+\/roles\/[^/]+$/],
  ['post', /^\/users\/[^/]+\/roles\/[^/]+\/delegate$/],
];

/**
 * Si la ruta (sin /api/v1) es un otorgamiento o retiro, adelanta el motivo obligatorio en el cuerpo; un `.send({...})`
 * posterior se combina con él (superagent fusiona objetos). Para probar el motivo ausente, no use este helper.
 */
export const withGrantReason = <T extends { send(body: object): T }>(method: string, path: string, pending: T): T =>
  GRANT_ROUTES.some(([verb, route]) => verb === method && route.test(path))
    ? pending.send({ reason: GRANT_REASON })
    : pending;

/**
 * Rol nuevo, como lo crearía el SUPER_ADMIN desde la interfaz: un código cualquiera y los permisos indicados. Sirve
 * para probar que el comportamiento lo deciden los permisos y no el nombre del rol. Devuelve el código.
 */
export const createPermissionRole = async (
  dataSource: DataSource,
  permissionCodes: ReadonlyArray<string>,
  prefix = 'IT_ROLE',
): Promise<string> => {
  const code = `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const roleId = await scalar<string>(
    dataSource,
    `INSERT INTO role (code, name, hierarchy_level, superior_role_id)
     VALUES ($1, $1, 2, (SELECT id FROM role WHERE code = 'SUPER_ADMIN')) RETURNING id`,
    [code],
  );
  await dataSource.query(
    `INSERT INTO role_permission (role_id, permission_id) SELECT $1, id FROM permission WHERE code = ANY($2::text[])`,
    [roleId, [...permissionCodes]],
  );
  return code;
};
