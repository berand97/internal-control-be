import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { OPENAPI_TAG_GROUPS, OPENAPI_TAG_META } from './openapi-tags.js';

export const API_GLOBAL_PREFIX = 'api/v1';

export const OPENAPI_JSON_PATH = '/api/openapi.json';

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

export const serializeOpenApiDocument = (document: OpenAPIObject): string =>
  `${JSON.stringify(document, null, 2)}\n`;
