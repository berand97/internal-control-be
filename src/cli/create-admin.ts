import 'dotenv/config';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module.js';
import dataSource from '../database/data-source.js';
import {
  INSTITUTIONAL_EMAIL_MESSAGE,
  INSTITUTIONAL_EMAIL_REGEX,
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_POLICY_REGEX,
} from '../common/validation/password.constants.js';
import { CryptoModule } from '../shared/crypto/crypto.module.js';
import { HashService } from '../shared/crypto/hash.service.js';

const ADMIN_ROLE_CODE = 'SUPER_ADMIN';

@Module({ imports: [AppConfigModule, CryptoModule] })
class CreateAdminModule {}

const readArg = (name: string, envKey: string): string | undefined => {
  const prefix = `--${name}=`;
  const fromArgs = process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  const value = fromArgs ?? process.env[envKey];
  return value && value.trim() !== '' ? value.trim() : undefined;
};

const requireArg = (name: string, envKey: string): string => {
  const value = readArg(name, envKey);
  if (!value) {
    throw new Error(`Falta --${name} o la variable ${envKey}`);
  }
  return value;
};

const firstId = (rows: unknown): string => {
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string') {
    return row.id;
  }
  throw new Error('La inserción no retornó un id');
};

const createAdmin = async (): Promise<void> => {
  const username = requireArg('username', 'ADMIN_USERNAME');
  const password = requireArg('password', 'ADMIN_PASSWORD');
  const email = requireArg('email', 'ADMIN_EMAIL');
  const firstName = requireArg('first-name', 'ADMIN_FIRST_NAME');
  const lastName = requireArg('last-name', 'ADMIN_LAST_NAME');

  if (!PASSWORD_POLICY_REGEX.test(password)) {
    throw new Error(PASSWORD_POLICY_MESSAGE);
  }
  if (!INSTITUTIONAL_EMAIL_REGEX.test(email)) {
    throw new Error(INSTITUTIONAL_EMAIL_MESSAGE);
  }

  const context = await NestFactory.createApplicationContext(CreateAdminModule, {
    logger: ['error'],
  });
  await dataSource.initialize();
  try {
    const existing: unknown = await dataSource.query(
      'SELECT id FROM app_user WHERE username = $1',
      [username],
    );
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`El usuario ${username} ya existe; no se hizo ningún cambio.`);
      return;
    }

    const passwordHash = await context.get(HashService).hash(password);

    await dataSource.transaction(async (manager) => {
      const roleRows: unknown = await manager.query(
        'SELECT id FROM role WHERE code = $1 AND deleted_at IS NULL',
        [ADMIN_ROLE_CODE],
      );
      const roleId = firstId(roleRows);
      const personId = firstId(
        await manager.query(
          `INSERT INTO person (first_name, last_name, email, position_title)
           VALUES ($1, $2, $3, 'Administrador del sistema')
           RETURNING id`,
          [firstName, lastName, email],
        ),
      );
      const userId = firstId(
        await manager.query(
          `INSERT INTO app_user (person_id, username, password_hash, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id`,
          [personId, username, passwordHash],
        ),
      );
      await manager.query(
        `INSERT INTO user_role (user_id, role_id, scope_type)
         VALUES ($1, $2, 'GLOBAL')`,
        [userId, roleId],
      );
    });
    console.log(`Usuario ${username} creado con rol ${ADMIN_ROLE_CODE}.`);
  } finally {
    await dataSource.destroy();
    await context.close();
  }
};

try {
  await createAdmin();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
