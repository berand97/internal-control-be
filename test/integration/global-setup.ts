import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataSource } from 'typeorm';

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function adminUrlFromDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

loadEnvFile(resolve(process.cwd(), '.env'));

const ADMIN_URL =
  process.env['TEST_DATABASE_ADMIN_URL'] ??
  (process.env['DATABASE_URL']
    ? adminUrlFromDatabaseUrl(process.env['DATABASE_URL'])
    : 'postgres://postgres:postgres@localhost:5432/postgres');
const TEST_DB = process.env['TEST_DATABASE_NAME'] ?? 'control_interno_it';
const STORAGE_DIR = join(tmpdir(), 'control-interno-it-storage');

export const testDatabaseUrl = (): string => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
};

const admin = async (sql: string): Promise<void> => {
  const connection = new DataSource({ type: 'postgres', url: ADMIN_URL });
  await connection.initialize();
  try {
    await connection.query(sql);
  } finally {
    await connection.destroy();
  }
};

export default async function setup(): Promise<() => Promise<void>> {
  await rm(STORAGE_DIR, { recursive: true, force: true });
  await admin(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  await admin(`CREATE DATABASE "${TEST_DB}"`);

  process.env['DATABASE_URL'] = testDatabaseUrl();
  const { default: dataSource } = await import('../../src/database/data-source.js');
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    await dataSource.destroy();
  }

  return async () => {
    await rm(STORAGE_DIR, { recursive: true, force: true });
    if (process.env['KEEP_TEST_DATABASE'] !== 'true') {
      await admin(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    }
  };
}
