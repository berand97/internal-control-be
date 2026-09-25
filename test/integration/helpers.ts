import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
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
