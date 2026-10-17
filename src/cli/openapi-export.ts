import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FORBIDDEN_DATABASES = new Set(['internal_control']);
const INERT_SECRET = 'openapi-export-inert-secret-not-used';

const fail = (message: string): never => {
  console.error(`openapi:export: ${message}`);
  process.exit(1);
};

const checkDatabaseUrl = async (raw: string | undefined): Promise<void> => {
  if (!raw) {
    fail('defina DATABASE_URL (BD local de pruebas ya migrada) en el entorno del comando; no se lee de .env');
  }
  const { isLocalDatabaseHost } = await import('../config/database-host-guard.js');
  let url: URL;
  try {
    url = new URL(raw as string);
  } catch {
    return fail('DATABASE_URL no es una URL válida');
  }
  if (!isLocalDatabaseHost(url.hostname)) {
    fail('DATABASE_URL debe apuntar a una BD local (localhost); nunca a la desplegada');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (FORBIDDEN_DATABASES.has(database)) {
    fail(`no use la BD '${database}' (es la del desarrollador): use una BD de pruebas`);
  }
};

const main = async (): Promise<void> => {
  await checkDatabaseUrl(process.env['DATABASE_URL']);
  process.env['JWT_ACCESS_SECRET'] ||= INERT_SECRET;
  process.env['JWT_REFRESH_SECRET'] ||= INERT_SECRET;

  const target = resolve(process.argv[2] ?? 'dist/openapi.json');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const { API_GLOBAL_PREFIX, createOpenApiDocument, serializeOpenApiDocument } = await import(
    '../common/swagger/openapi-document.js'
  );

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], abortOnError: false });
  try {
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    const document = createOpenApiDocument(app);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serializeOpenApiDocument(document), 'utf8');
    console.log(`openapi:export: ${Object.keys(document.paths).length} rutas → ${target}`);
  } finally {
    await app.close();
  }
};

await main();
