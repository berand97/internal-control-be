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

export const discardInventoryActRequests = async (dataSource: DataSource): Promise<void> => {
  await dataSource.query(
    `UPDATE physical_inventory_act SET document_request_id = NULL
     WHERE document_request_id IN (SELECT id FROM document_request WHERE status <> 'GENERATED' AND payload->>'entityType' = 'PHYSICAL_INVENTORY_ACT')`,
  );
  await dataSource.query(
    `DELETE FROM document_request WHERE status <> 'GENERATED' AND payload->>'entityType' = 'PHYSICAL_INVENTORY_ACT'`,
  );
};

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

export const withGrantReason = <T extends { send(body: object): T }>(method: string, path: string, pending: T): T =>
  GRANT_ROUTES.some(([verb, route]) => verb === method && route.test(path))
    ? pending.send({ reason: GRANT_REASON })
    : pending;

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

export const grantControlSigner = async (dataSource: DataSource, personId: string): Promise<void> => {
  await dataSource.query(
    `INSERT INTO app_user (person_id, username, password_hash, status)
     SELECT $1::uuid, 'it.firma.' || substr(md5($1::uuid::text), 1, 12), 'x', 'ACTIVE'
     WHERE NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1::uuid)`,
    [personId],
  );
  const code = await createPermissionRole(dataSource, ['act:sign_control:global'], 'IT_FIRMA_CI');
  await dataSource.query(
    `INSERT INTO user_role (user_id, role_id, scope_type)
     SELECT u.id, r.id, 'GLOBAL' FROM app_user u, role r WHERE u.person_id = $1 AND r.code = $2`,
    [personId, code],
  );
};
