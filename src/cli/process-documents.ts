import 'dotenv/config';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentsModule } from '../modules/documents/documents.module.js';
import { InventoriesModule } from '../modules/inventories/inventories.module.js';
import { DocumentEngineService } from '../modules/documents/services/document-engine.service.js';

@Module({
  imports: [AppConfigModule, DatabaseModule, DocumentsModule, InventoriesModule],
})
class ProcessDocumentsModule {}

const run = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(ProcessDocumentsModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(DocumentEngineService).processPending(10);
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
