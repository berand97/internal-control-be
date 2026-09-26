import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { OPENAPI_TAG_GROUPS, OPENAPI_TAG_META } from './openapi-tags.js';

/** Prefijo global de las rutas del API. Forma parte de las rutas del documento OpenAPI. */
export const API_GLOBAL_PREFIX = 'api/v1';

/** Ruta donde la aplicación sirve el documento (src/main.ts). */
export const OPENAPI_JSON_PATH = '/api/openapi.json';

/**
 * Documento OpenAPI de la aplicación. Lo usan el servidor (src/main.ts, GET /api/openapi.json) y el exportador sin
 * servidor (src/cli/openapi-export.ts): un solo lugar para título, etiquetas y extensiones, para que ambos produzcan
 * el mismo documento. La aplicación debe tener ya el prefijo global (API_GLOBAL_PREFIX).
 */
export const createOpenApiDocument = (app: INestApplication): OpenAPIObject => {
  const openApiBuilder = new DocumentBuilder()
    .setTitle('Control Interno UNAC')
    .setDescription('API del Sistema de Gestión de Activos')
    .setVersion('1.0.0')
    .addBearerAuth();

  for (const tag of OPENAPI_TAG_META) {
    openApiBuilder.addTag(tag.name, tag.description);
  }

  const openApiConfig = openApiBuilder
    .addExtension('x-tagGroups', OPENAPI_TAG_GROUPS)
    .build();

  return SwaggerModule.createDocument(app, openApiConfig);
};

/** Serialización estable del documento: la misma que usa el frontend (tools/api-types.mts) para su copia. */
export const serializeOpenApiDocument = (document: OpenAPIObject): string =>
  `${JSON.stringify(document, null, 2)}\n`;
