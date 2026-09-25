import './instrumentation.js';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import cookieParser from 'cookie-parser';
import { AppModule, ObserveInstrument } from './app.module.js';
import { applyTrustProxy } from './common/http/trust-proxy.js';
import { createAppValidationPipe } from './common/pipes/app-validation.pipe.js';
import {
  OPENAPI_TAG_GROUPS,
  OPENAPI_TAG_META,
} from './common/swagger/openapi-tags.js';
import type { AppConfig } from './config/configuration.js';

function publishApiDocs(app: INestApplication): void {
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

  const document = SwaggerModule.createDocument(app, openApiConfig);

  app
    .getHttpAdapter()
    .get(
      '/api/openapi.json',
      (_req: unknown, res: { json: (body: unknown) => void }) =>
        res.json(document),
    );

  app.use(
    '/api/reference',
    apiReference({
      spec: { content: document },
      theme: 'purple',
    }),
  );
}

async function bootstrap(): Promise<void> {
  const nestObserveEnabled = Boolean(
    process.env['OBSERVE_APP_KEY'] && process.env['OBSERVE_APP_SECRET'],
  );
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    nestObserveEnabled && ObserveInstrument
      ? { instrument: ObserveInstrument }
      : {},
  );

  const config = app.get(ConfigService<AppConfig, true>);

  applyTrustProxy(app, config.getOrThrow('trustProxy', { infer: true }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createAppValidationPipe());
  app.enableCors({
    origin: Array.from(
      config.getOrThrow('cors.allowedOrigins', { infer: true }),
    ),
    credentials: true,
  });

  if (config.getOrThrow('apiDocsEnabled', { infer: true })) {
    publishApiDocs(app);
  }

  await app.listen(config.getOrThrow('port', { infer: true }));
}

await bootstrap();
