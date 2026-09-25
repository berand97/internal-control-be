import 'dotenv/config';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { resolve } from 'node:path';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { writeIssuesCsv } from '../modules/staging/report/write-issues-csv.js';
import { StagingDiagnosticsService } from '../modules/staging/services/staging-diagnostics.service.js';
import { StagingLoaderService } from '../modules/staging/services/staging-loader.service.js';
import { isStagingSourceKind, STAGING_SOURCE_KINDS } from '../modules/staging/staging-sources.js';
import { StagingModule } from '../modules/staging/staging.module.js';

@Module({ imports: [AppConfigModule, DatabaseModule, StagingModule] })
class StagingCliModule {}

const USAGE = `Uso:
  node dist/cli/staging.js load <archivo.xlsx> --kind=${STAGING_SOURCE_KINDS.join('|')}
  node dist/cli/staging.js diagnose --batch=<id> [--cost-centers=<id>] --out=<problemas.csv>`;

const option = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const seconds = (start: bigint): string =>
  (Number(process.hrtime.bigint() - start) / 1e9).toFixed(1);

const run = async (): Promise<void> => {
  const [command, file] = process.argv.slice(2);
  const context = await NestFactory.createApplicationContext(StagingCliModule, {
    logger: ['error'],
  });
  try {
    if (command === 'load' && file) {
      const kind = option('kind') ?? '';
      if (!isStagingSourceKind(kind)) {
        throw new Error(USAGE);
      }
      const start = process.hrtime.bigint();
      const result = await context.get(StagingLoaderService).load(resolve(file), kind);
      console.log(
        `${result.created ? 'Lote creado' : 'Ya estaba cargado, no se duplicó'}: ${result.batchId} (${seconds(start)} s)`,
      );
      console.table(result.sheets);
      return;
    }
    if (command === 'diagnose') {
      const batch = option('batch');
      const out = option('out');
      if (!batch || !out) {
        throw new Error(USAGE);
      }
      const start = process.hrtime.bigint();
      const diagnosis = await context
        .get(StagingDiagnosticsService)
        .diagnoseAssetReport(batch, option('cost-centers') ?? null);
      await writeIssuesCsv(resolve(out), diagnosis.issues);
      for (const sheet of diagnosis.sheets) {
        console.log(`\n${sheet.sheet}`);
        console.table(
          sheet.metrics.map((metric) => ({
            metrica: metric.label,
            valor: metric.value ?? 'N/D',
            sobre: metric.base ?? '',
            detalle: metric.detail ?? '',
          })),
        );
      }
      console.table(diagnosis.otherSheets);
      console.log(
        `${diagnosis.issues.length} problemas por fila escritos en ${resolve(out)} (${seconds(start)} s)`,
      );
      return;
    }
    throw new Error(USAGE);
  } finally {
    await context.close();
  }
};

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
