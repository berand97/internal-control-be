import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { StorageDriver } from '../../../config/configuration.js';
import { IDENTITY_DOCUMENT_TYPE_CODES, IDENTITY_DOCUMENT_TYPES } from '../../../common/identity/identity-document-types.js';
import { PHYSICAL_CONDITIONS } from '../../assets/enums/physical-condition.enum.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import type { RawCellValue } from '../excel/read-workbook.js';
import { IMPORT_TARGETS, type ImportTarget, isImportTarget, type TemplateCatalog } from '../import/import-fields.js';
import {
  buildTemplate,
  type CatalogEntry,
  catalogsUsedBy,
  contentHash,
  META_SHEET,
  readTemplateMarker,
  type TemplateCatalogs,
  templateVersion,
  XLSX_MIME,
} from './import-template.js';

/**
 * Etiquetas de la condición física. Mismas que CONDITION_LABELS (DocumentEngineService) y
 * PHYSICAL_CONDITION_LABELS (LoansService): no hay una fuente común en el módulo de activos.
 */
const PHYSICAL_CONDITION_LABELS: Record<string, string> = {
  NEW: 'Nuevo',
  GOOD: 'Bueno',
  FAIR: 'Regular',
  POOR: 'Malo',
  OBSOLETE: 'Obsoleto',
};

export interface ImportTemplateRecord {
  readonly target: ImportTarget;
  readonly version: string;
  readonly definitionHash: string;
  readonly contentHash: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly generatedAt: string;
  /** Primera vez que se generó esta versión (desde cuándo rige esta definición en este entorno). */
  readonly versionSince: string;
  readonly catalogCounts: Record<string, number>;
}

/** Plantilla reconocida en un archivo subido. */
export interface TemplateDetection {
  readonly target: string;
  readonly version: string;
  /** Versión vigente del mismo destino; null si el destino del archivo no existe. */
  readonly currentVersion: string | null;
  readonly outdated: boolean;
  /** La versión del archivo fue generada por este entorno (está en el historial). */
  readonly knownVersion: boolean;
  readonly versionGeneratedAt: string | null;
  readonly dataSheet: string;
  readonly headerRow: number;
  readonly example: Record<string, RawCellValue>;
}

interface TemplateRow {
  readonly target: ImportTarget;
  readonly version: string;
  readonly definition_hash: string;
  readonly content_hash: string;
  readonly file_name: string;
  readonly storage_driver: string;
  readonly storage_key: string;
  readonly byte_size: number;
  readonly checksum_sha256: string;
  readonly generated_at: Date;
  readonly version_since: Date;
}

const ROW_SELECT = `SELECT t.*, (SELECT min(v.generated_at) FROM import_template v WHERE v.version = t.version) AS version_since
  FROM import_template t`;

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

/**
 * Versión de plantilla que trae un archivo ya cargado en staging (hoja oculta «_plantilla»), o null si el archivo
 * no viene de una plantilla. Función suelta para que ExcelImportService la use sin depender del storage.
 */
export const detectTemplate = async (
  db: Pick<DataSource, 'query'>,
  batchId: string,
): Promise<TemplateDetection | null> => {
  const rows = (await db.query(
    'SELECT cells FROM staging_row WHERE batch_id = $1 AND sheet_name = $2 ORDER BY row_number LIMIT 50',
    [batchId, META_SHEET],
  )) as Array<{ cells: Record<string, RawCellValue> }>;
  const marker = readTemplateMarker(rows);
  if (!marker) {
    return null;
  }
  const currentVersion = isImportTarget(marker.target) ? templateVersion(marker.target) : null;
  const [known] = (await db.query(
    'SELECT min(generated_at) AS since FROM import_template WHERE version = $1 AND target = $2',
    [marker.version, marker.target],
  )) as Array<{ since: Date | null }>;
  return {
    target: marker.target,
    version: marker.version,
    currentVersion,
    outdated: currentVersion !== null && currentVersion !== marker.version,
    knownVersion: Boolean(known?.since),
    versionGeneratedAt: known?.since ? new Date(known.since).toISOString() : null,
    dataSheet: marker.dataSheet,
    headerRow: marker.headerRow,
    example: marker.example,
  };
};

/**
 * Plantillas de importación en el storage del sistema. Regla de regeneración: se calcula el hash de contenido
 * (definición + catálogos); si ya hay un archivo para ese hash se sirve el guardado; si no, se genera, se guarda y
 * se registra en import_template. Nunca por tiempo. Un bloqueo por destino evita generar dos veces a la vez.
 */
@Injectable()
export class ImportTemplateService {
  private readonly logger = new Logger(ImportTemplateService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  async list(actorId: string | null): Promise<ReadonlyArray<ImportTemplateRecord>> {
    const records: ImportTemplateRecord[] = [];
    for (const target of IMPORT_TARGETS) {
      records.push((await this.ensure(target, actorId, false)).record);
    }
    return records;
  }

  async download(target: ImportTarget, actorId: string | null): Promise<{ fileName: string; body: Buffer }> {
    const { record, body } = await this.ensure(target, actorId, true);
    return { fileName: record.fileName, body: body ?? Buffer.alloc(0) };
  }

  async catalogs(target: ImportTarget): Promise<TemplateCatalogs> {
    const catalogs: Partial<Record<TemplateCatalog, ReadonlyArray<CatalogEntry>>> = {};
    for (const catalog of catalogsUsedBy(target)) {
      catalogs[catalog] = await this.catalog(catalog);
    }
    return catalogs;
  }

  /** Versión de plantilla que trae el archivo subido (hoja oculta «_plantilla»), o null. */
  detect(batchId: string): Promise<TemplateDetection | null> {
    return detectTemplate(this.dataSource, batchId);
  }

  private async ensure(
    target: ImportTarget,
    actorId: string | null,
    withBody: boolean,
  ): Promise<{ record: ImportTemplateRecord; body: Buffer | null }> {
    const catalogs = await this.catalogs(target);
    const content = contentHash(target, catalogs);
    const counts = Object.fromEntries(Object.entries(catalogs).map(([name, entries]) => [name, entries.length]));
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import_template:${target}`]);
      const [existing] = (await manager.query(
        `${ROW_SELECT} WHERE t.target = $1 AND t.content_hash = $2 ORDER BY t.generated_at DESC LIMIT 1`,
        [target, content],
      )) as TemplateRow[];
      if (existing && !withBody) {
        return { record: this.record(existing, counts), body: null };
      }
      if (existing) {
        const stored = await this.storage.getFrom(existing.storage_driver as StorageDriver, existing.storage_key).catch(() => null);
        if (stored && sha256(stored) === existing.checksum_sha256) {
          return { record: this.record(existing, counts), body: stored };
        }
        this.logger.warn(`Plantilla ${target} ${existing.version}: el archivo guardado no está o cambió; se regenera`);
      }
      const built = await buildTemplate({ target, catalogs, generatedAt: new Date() });
      const key = `import-templates/${target}/${built.version}/${built.contentHash.slice(0, 16)}.xlsx`;
      const stored = await this.storage.put({ key, body: built.body, contentType: XLSX_MIME });
      await manager.query(
        `INSERT INTO import_template (target, version, definition_hash, content_hash, file_name, storage_driver,
           storage_key, byte_size, checksum_sha256, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          target,
          built.version,
          built.definitionHash,
          built.contentHash,
          built.fileName,
          stored.driver,
          stored.key,
          built.body.length,
          sha256(built.body),
          actorId,
        ],
      );
      const [created] = (await manager.query(
        `${ROW_SELECT} WHERE t.target = $1 AND t.content_hash = $2 ORDER BY t.generated_at DESC LIMIT 1`,
        [target, built.contentHash],
      )) as TemplateRow[];
      if (!created) {
        throw new Error('No quedó registrada la plantilla generada');
      }
      return { record: this.record(created, counts), body: built.body };
    });
  }

  private record(row: TemplateRow, catalogCounts: Record<string, number>): ImportTemplateRecord {
    return {
      target: row.target,
      version: row.version,
      definitionHash: row.definition_hash,
      contentHash: row.content_hash,
      fileName: row.file_name,
      byteSize: Number(row.byte_size),
      generatedAt: new Date(row.generated_at).toISOString(),
      versionSince: new Date(row.version_since).toISOString(),
      catalogCounts,
    };
  }

  private async catalog(catalog: TemplateCatalog): Promise<ReadonlyArray<CatalogEntry>> {
    switch (catalog) {
      case 'COST_CENTERS':
        // Todos los centros: la clasificación acepta cualquier centro del catálogo.
        return (await this.dataSource.query(
          'SELECT external_code AS code, name FROM cost_center ORDER BY external_code',
        )) as CatalogEntry[];
      case 'CATEGORIES':
        return (await this.dataSource.query(
          'SELECT code, name FROM asset_category WHERE is_active ORDER BY code',
        )) as CatalogEntry[];
      case 'DOCUMENT_TYPES':
        return IDENTITY_DOCUMENT_TYPE_CODES.map((code) => ({ code, name: IDENTITY_DOCUMENT_TYPES[code].label }));
      case 'PHYSICAL_CONDITIONS':
        return PHYSICAL_CONDITIONS.map((code) => ({ code, name: PHYSICAL_CONDITION_LABELS[code] ?? code }));
    }
  }
}
