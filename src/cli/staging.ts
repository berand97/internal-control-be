import 'dotenv/config';
import 'reflect-metadata';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import dataSourceConfig from '../database/data-source.js';
import { FeaturesModule } from '../modules/features/features.module.js';
import { ExcelImportService } from '../modules/staging/services/excel-import.service.js';
import { isImportTarget, isUnknownCostCenterPolicy } from '../modules/staging/import/import-fields.js';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { writeIssuesCsv } from '../modules/staging/report/write-issues-csv.js';
import { StagingDiagnosticsService } from '../modules/staging/services/staging-diagnostics.service.js';
import { StagingLoaderService } from '../modules/staging/services/staging-loader.service.js';
import { isStagingSourceKind, STAGING_SOURCE_KINDS } from '../modules/staging/staging-sources.js';
import { StagingModule } from '../modules/staging/staging.module.js';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    TypeOrmModule.forFeature([...(dataSourceConfig.options.entities as Type<unknown>[])]),
    FeaturesModule,
    StagingModule,
  ],
})
class StagingCliModule {}

const USAGE = `Uso:
  node dist/cli/staging.js load <archivo.xlsx> --kind=${STAGING_SOURCE_KINDS.join('|')}
  node dist/cli/staging.js diagnose --batch=<id> [--cost-centers=<id>] --out=<problemas.csv>
  node dist/cli/staging.js import <archivo.xlsx> --sheet=<hoja> --target=ASSETS|COST_CENTERS
      --map=campo=Letra,... --actor=<usuario> [--header-row=N] [--unknown-cost-centers=quarantine|create] [--confirm]`;

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
    if (command === 'import' && file) {
      const target = option('target') ?? '';
      const sheet = option('sheet');
      const map = option('map');
      const username = option('actor');
      const policy = option('unknown-cost-centers') ?? 'quarantine';
      if (!isImportTarget(target) || !sheet || !map || !username || !isUnknownCostCenterPolicy(policy)) {
        throw new Error(USAGE);
      }
      const [user] = (await context
        .get(DataSource)
        .query('SELECT id FROM app_user WHERE username = $1', [username])) as Array<{ id: string }>;
      if (!user) {
        throw new Error(`No existe el usuario ${username}`);
      }
      const mapping = Object.fromEntries(map.split(',').map((pair) => pair.split('=') as [string, string]));
      const headerRow = option('header-row');
      const service = context.get(ExcelImportService);
      const uploadStart = process.hrtime.bigint();
      const upload = await service.upload(await readFile(resolve(file)), basename(file), user.id);
      console.log(`Archivo ${upload.created ? 'cargado' : 'ya estaba cargado'}: ${upload.batchId} (${seconds(uploadStart)} s)`);
      const previewStart = process.hrtime.bigint();
      const preview = await service.preview(
        upload.batchId,
        {
          sheet,
          target,
          mapping,
          unknownCostCenters: policy,
          ...(headerRow ? { headerRow: Number(headerRow) } : {}),
        },
        user.id,
      );
      const { metrics, ...summary } = preview.summary;
      console.log(`\nVista previa ${preview.importId} (${seconds(previewStart)} s)`);
      console.log(JSON.stringify(summary, null, 2));
      if (metrics.length > 0) {
        console.table(metrics.map((metric) => ({ metrica: metric.label, valor: metric.value ?? 'N/D', detalle: metric.detail ?? '' })));
      }
      if (!process.argv.includes('--confirm')) {
        console.log('\nNada se escribió en el modelo. Agrega --confirm para importar.');
        return;
      }
      const confirmStart = process.hrtime.bigint();
      const result = await service.confirm(preview.importId, user.id);
      console.log(`\nImportación confirmada (${seconds(confirmStart)} s)`);
      console.log(JSON.stringify(result, null, 2));
      const reconciliation = await service.reconcile(preview.importId);
      if (reconciliation.length > 0) {
        console.log('\nConciliación diagnóstico ↔ modelo');
        console.table(reconciliation);
      }
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
      console.log('\nRelaciones entre hojas de activos');
      console.table(diagnosis.relations);
      console.log('\nOtras hojas');
      console.table(
        diagnosis.otherSheets.map((sheet) => ({ ...sheet, headers: sheet.headers.join(', ') })),
      );
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
