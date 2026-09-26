/**
 * Exporta el documento OpenAPI a un archivo SIN levantar el servidor (no llama a listen ni ocupa puertos):
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/<bd_de_pruebas> pnpm openapi:export [ruta]
 *
 * - `ruta` por defecto: dist/openapi.json (relativa al directorio del backend). Para regenerar el contrato del
 *   frontend: `pnpm openapi:export ../frontend/openapi/openapi.json` y luego `pnpm api:types` en el frontend.
 * - Crea la aplicación Nest completa (AppModule) porque el documento se construye escaneando sus controladores, y
 *   TypeORM abre la conexión al crearla: necesita una BD local YA MIGRADA. Use una BD de pruebas (p.ej. una copia
 *   de control_interno_staging), nunca `internal_control` (la del desarrollador) ni la desplegada. El exportador
 *   solo lee: no ejecuta los ganchos de arranque (onModuleInit, cron), no migra y no escribe.
 * - DATABASE_URL es obligatoria en el entorno del proceso: no se toma de .env, para que un .env de desarrollo no
 *   decida a qué BD se conecta. Solo se aceptan hosts locales.
 * - Los secretos JWT no intervienen en el documento; si faltan se rellenan con un valor inerte solo para este proceso.
 * - El documento es el mismo que sirve GET /api/openapi.json: ambos salen de createOpenApiDocument
 *   (src/common/swagger/openapi-document.ts) con el mismo prefijo global, y se escribe con la misma serialización
 *   que usa el frontend para su copia (tools/api-types.mts).
 */
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
  // Antes de importar la aplicación: data-source.ts carga .env y no debe decidir la BD.
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
