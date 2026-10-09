import './instrumentation.js';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { apiReference } from '@scalar/nestjs-api-reference';
import cookieParser from 'cookie-parser';
import { AppModule, ObserveInstrument } from './app.module.js';
import { buildCorsOptions } from './common/http/cors.js';
import { applyTrustProxy } from './common/http/trust-proxy.js';
import { createAppValidationPipe } from './common/pipes/app-validation.pipe.js';
import {
  API_GLOBAL_PREFIX,
  createOpenApiDocument,
  OPENAPI_JSON_PATH,
} from './common/swagger/openapi-document.js';
import type { AppConfig } from './config/configuration.js';
import { FeatureFlagsService } from './modules/features/services/feature-flags.service.js';

function publishApiDocs(app: INestApplication): void {
  const document = createOpenApiDocument(app);

  app
    .getHttpAdapter()
    .get(
      OPENAPI_JSON_PATH,
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
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  app.useGlobalPipes(createAppValidationPipe());
  app.enableCors(
    buildCorsOptions(config.getOrThrow('cors.allowedOrigins', { infer: true })),
  );

  if (config.getOrThrow('apiDocsEnabled', { infer: true })) {
    publishApiDocs(app);
  }

  // Solo el proceso HTTP mantiene la caché de módulos al día con la BD (NOTIFY + relectura periódica).
  await app.get(FeatureFlagsService).startLiveSync();

  await app.listen(config.getOrThrow('port', { infer: true }));
}

await bootstrap();
