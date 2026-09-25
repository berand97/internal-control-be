import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  IDENTITY_DOCUMENT_TYPE_CODES,
  IDENTITY_DOCUMENT_TYPES,
  type IdentityDocumentType,
} from '../../../common/identity/identity-document-types.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import {
  type AssetColumn,
  diagnoseAssetSheet,
  type Issue,
  type Metric,
} from '../diagnostics/asset-report-diagnostics.js';
import type { RawCellValue } from '../excel/read-workbook.js';
import {
  ASSET_IMPORT_FIELDS,
  COLUMN_LETTER,
  detectHeaderRow,
  fieldsFor,
  type ImportField,
  type ImportTarget,
  type UnknownCostCenterPolicy,
} from '../import/import-fields.js';
import { StagingLoaderService } from './staging-loader.service.js';

export const PLACEHOLDER_CATEGORY = 'SIN_CLASIFICAR';
export const PLACEHOLDER_ACQUISITION_TYPE = 'NO_REGISTRADO';
const CHUNK_SIZE = 2000;
const MOVEMENT_CHUNK = 500;

export interface UploadedSheet {
  readonly name: string;
  readonly rows: number;
  readonly detectedHeaderRow: number;
  readonly columns: Record<string, string>;
}

export interface PreviewRequest {
  readonly sheet: string;
  readonly headerRow?: number;
  readonly target: ImportTarget;
  readonly mapping: Record<string, string>;
  readonly unknownCostCenters?: UnknownCostCenterPolicy;
  /** Solo PERSONS: tipo de documento que el operador declara para todo el lote (el archivo no trae columna). */
  readonly documentType?: IdentityDocumentType;
}

/** De dónde sale el tipo de documento de las personas de un lote. */
export type DocumentTypeSource = 'COLUMN' | 'DECLARED_BY_OPERATOR' | 'UNKNOWN';

interface ImportOptions {
  readonly unknownCostCenters?: UnknownCostCenterPolicy;
  readonly documentTypeSource?: DocumentTypeSource;
  readonly declaredDocumentType?: IdentityDocumentType;
  readonly declaredBy?: string | null;
}

export interface ImportSummary {
  readonly rowsRead: number;
  readonly toInsert: number;
  readonly alreadyPresent: number;
  readonly quarantined: Record<string, number>;
  readonly flagged: Record<string, number>;
  readonly issues: number;
  readonly metrics: ReadonlyArray<Metric>;
}

export interface ImportResult {
  readonly inserted: number;
  readonly skippedAlreadyPresent: number;
  readonly quarantined: Record<string, number>;
  readonly costCentersCreated: number;
  readonly registrationMovements: number;
  readonly seconds: { readonly rows: number; readonly movements: number };
}

interface ImportRow {
  readonly id: string;
  readonly batch_id: string;
  readonly sheet_name: string;
  readonly header_row: number;
  readonly target: ImportTarget;
  readonly mapping: Record<string, string>;
  readonly options: ImportOptions;
  readonly status: 'PREVIEWED' | 'CONFIRMED';
  readonly file_name: string;
}

interface Classified {
  readonly rowsRead: number;
  readonly toInsert: number;
  readonly alreadyPresent: number;
  readonly quarantined: Record<string, number>;
  readonly flagged: Record<string, number>;
  readonly reasons: ReadonlyArray<{ row_number: number; legacy_id: string | null; reason: string; detail: string | null }>;
  readonly metrics?: ReadonlyArray<Metric>;
}

class PreviewRollback extends Error {}

export interface ReconciliationRow {
  readonly check: string;
  readonly diagnostic: number;
  readonly model: number;
  readonly quarantined: number;
  readonly matches: boolean;
}

const reconciled = (check: string, diagnostic: number, model: number, quarantined: number): ReconciliationRow => ({
  check,
  diagnostic,
  model,
  quarantined,
  matches: diagnostic === model + quarantined,
});

const RECONCILED_FLAGS: ReadonlyArray<readonly [string, ReadonlyArray<string>, string]> = [
  ['Código TEMP', ['BARCODE_TEMP'], 'BARCODE_TEMP'],
  ['Código duplicado', ['BARCODE_DUPLICATED'], 'BARCODE_DUPLICATED'],
  ['Código vacío', ['BARCODE_EMPTY'], 'BARCODE_EMPTY'],
  ['Sin fecha de compra', ['PURCHASE_DATE_MISSING'], 'ACQUISITION_DATE_MISSING'],
  ['Fecha de compra inválida o 1970', ['PURCHASE_DATE_NOT_A_DATE', 'PURCHASE_DATE_EPOCH'], 'ACQUISITION_DATE_INVALID'],
  ['Precio en 0', ['PRICE_ZERO'], 'PRICE_ZERO'],
  ['Precio vacío o no numérico', ['PRICE_MISSING', 'PRICE_NOT_A_NUMBER'], 'PRICE_MISSING'],
  ['Centro de costo inexistente', ['COST_CENTER_UNKNOWN'], 'COST_CENTER_NOT_IN_CATALOG'],
];

const seconds = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e9;

const col = (mapping: Record<string, string>, field: string): string => {
  const letter = mapping[field];
  if (!letter) {
    return 'NULL::text';
  }
  return `NULLIF(btrim(r.cells ->> '${letter}'), '')`;
};

const colType = (mapping: Record<string, string>, field: string): string => {
  const letter = mapping[field];
  return letter ? `r.cell_types ->> '${letter}'` : 'NULL::text';
};

const countBy = (rows: ReadonlyArray<{ key: string; count: number }>): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));

/**
 * Reglas del mapeo que dependen del destino. PERSONS: el nombre va en una columna (fullName) o en dos
 * (firstName + lastName); el tipo de documento sale de una columna o lo declara el operador, no de ambas; un
 * centro de costo inexistente siempre va a cuarentena (no se crea).
 */
const targetRuleErrors = (request: PreviewRequest): Array<{ field: string; message: string }> => {
  const errors: Array<{ field: string; message: string }> = [];
  const m = request.mapping;
  if (request.target !== 'PERSONS') {
    if (request.documentType) {
      errors.push({ field: 'documentType', message: 'Solo aplica a la importación de personas' });
    }
    return errors;
  }
  if (m['fullName'] && (m['firstName'] || m['lastName'])) {
    errors.push({ field: 'fullName', message: 'Use nombre completo o nombres y apellidos, no ambos' });
  }
  if (!m['fullName'] && !(m['firstName'] && m['lastName'])) {
    errors.push({ field: 'fullName', message: 'Falta el nombre: asigne nombre completo, o nombres y apellidos' });
  }
  if (m['documentType'] && request.documentType) {
    errors.push({
      field: 'documentType',
      message: 'El tipo de documento viene de una columna o lo declara el operador, no de ambas',
    });
  }
  if (request.unknownCostCenters === 'create') {
    errors.push({
      field: 'unknownCostCenters',
      message: 'En personas un centro de costo inexistente va a cuarentena; no se crea',
    });
  }
  return errors;
};

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** (código, forma plegada) de cada tipo del catálogo: el código y la abreviatura sin puntos. */
const DOCUMENT_TYPE_ALIASES = IDENTITY_DOCUMENT_TYPE_CODES.flatMap((code) => [
  `(${sqlText(code)}, ${sqlText(code)})`,
  `(${sqlText(code)}, ${sqlText(IDENTITY_DOCUMENT_TYPES[code].abbreviation.replaceAll('.', '').toUpperCase())})`,
]).join(', ');

const NUMERIC_DOCUMENT_TYPES = IDENTITY_DOCUMENT_TYPE_CODES.filter((code) => IDENTITY_DOCUMENT_TYPES[code].numeric)
  .map(sqlText)
  .join(', ');

const PERSON_ALREADY_PRESENT =
  'SELECT 1 FROM person p WHERE p.document_number = s.doc_number AND p.document_type IS NOT DISTINCT FROM s.doc_type';

@Injectable()
export class ExcelImportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly loader: StagingLoaderService,
    private readonly assetState: AssetStateService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async upload(
    content: Buffer,
    fileName: string,
    actorId: string | null,
  ): Promise<{ readonly batchId: string; readonly created: boolean; readonly sheets: ReadonlyArray<UploadedSheet> }> {
    const loaded = await this.loader.loadBuffer(content, fileName, 'UPLOAD', actorId);
    const sheets: UploadedSheet[] = [];
    for (const sheet of loaded.sheets) {
      const head = (await this.dataSource.query(
        `SELECT row_number, cells, cell_types FROM staging_row
         WHERE batch_id = $1 AND sheet_name = $2 AND row_number <= 30 ORDER BY row_number`,
        [loaded.batchId, sheet.name],
      )) as Array<{ row_number: number; cells: Record<string, RawCellValue>; cell_types: Record<string, string> }>;
      const headerRow = detectHeaderRow(
        head.map((row) => ({ rowNumber: row.row_number, cells: row.cells, types: row.cell_types })),
      );
      const header = head.find((row) => row.row_number === headerRow);
      sheets.push({
        name: sheet.name,
        rows: sheet.rows,
        detectedHeaderRow: headerRow,
        columns: Object.fromEntries(
          Object.entries(header?.cells ?? {}).map(([letter, value]) => [letter, String(value)]),
        ),
      });
    }
    return { batchId: loaded.batchId, created: loaded.created, sheets };
  }

  async preview(
    batchId: string,
    request: PreviewRequest,
    actorId: string | null,
  ): Promise<{ readonly importId: string; readonly summary: ImportSummary }> {
    const headerRow = await this.validate(batchId, request);
    const options: ImportOptions =
      request.target === 'PERSONS'
        ? {
            documentTypeSource: request.mapping['documentType']
              ? 'COLUMN'
              : request.documentType
                ? 'DECLARED_BY_OPERATOR'
                : 'UNKNOWN',
            ...(request.documentType ? { declaredDocumentType: request.documentType, declaredBy: actorId } : {}),
          }
        : { unknownCostCenters: request.unknownCostCenters ?? 'quarantine' };
    const [created] = (await this.dataSource.query(
      `INSERT INTO staging_import (batch_id, sheet_name, header_row, target, mapping, options, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [batchId, request.sheet, headerRow, request.target, JSON.stringify(request.mapping), JSON.stringify(options), actorId],
    )) as Array<{ id: string }>;
    const importId = created?.id ?? '';
    const job = await this.importRow(importId);

    let classified: Classified | null = null;
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.prepareCatalogs(manager, job, actorId);
        classified = await this.classify(manager, job);
        throw new PreviewRollback();
      });
    } catch (error) {
      if (!(error instanceof PreviewRollback)) {
        throw error;
      }
    }
    if (!classified) {
      throw new Error('La clasificación no produjo resultado');
    }
    const result: Classified = classified;

    const diagnosis =
      job.target === 'ASSETS' ? await this.diagnose(job) : { metrics: [], issues: [] as Issue[] };
    const issues: Issue[] = [...diagnosis.issues];
    const seen = new Set(issues.map((issue) => `${issue.rowNumber}:${issue.code}`));
    for (const row of result.reasons) {
      if (!seen.has(`${row.row_number}:${row.reason}`)) {
        issues.push({
          sheet: job.sheet_name,
          rowNumber: row.row_number,
          column: null,
          code: row.reason,
          rawValue: row.legacy_id,
          detail: row.detail,
        });
      }
    }
    const summary: ImportSummary = {
      rowsRead: result.rowsRead,
      toInsert: result.toInsert,
      alreadyPresent: result.alreadyPresent,
      quarantined: result.quarantined,
      flagged: result.flagged,
      issues: issues.length,
      metrics: job.target === 'ASSETS' ? diagnosis.metrics : (result.metrics ?? []),
    };
    await this.dataSource.transaction(async (manager) => {
      await this.saveIssues(manager, job, issues);
      await manager.query('UPDATE staging_import SET preview = $2 WHERE id = $1', [
        importId,
        JSON.stringify(summary),
      ]);
    });
    return { importId, summary };
  }

  async issues(importId: string, page: number, pageSize: number) {
    const rows = (await this.dataSource.query(
      `SELECT sheet_name AS sheet, row_number AS "rowNumber", column_name AS column,
              issue_code AS code, raw_value AS "rawValue", detail
       FROM staging_issue WHERE import_id = $1
       ORDER BY row_number NULLS FIRST, issue_code
       LIMIT $2 OFFSET $3`,
      [importId, pageSize, (page - 1) * pageSize],
    )) as Issue[];
    const [total] = (await this.dataSource.query(
      'SELECT count(*)::int AS count FROM staging_issue WHERE import_id = $1',
      [importId],
    )) as Array<{ count: number }>;
    return { items: rows, page, pageSize, total: total?.count ?? 0 };
  }

  async quarantine(importId: string) {
    return this.dataSource.query(
      `SELECT sheet_name AS sheet, row_number AS "rowNumber", legacy_asset_id AS "legacyAssetId", reason, detail
       FROM staging_quarantine WHERE import_id = $1 ORDER BY row_number, reason`,
      [importId],
    ) as Promise<ReadonlyArray<Record<string, unknown>>>;
  }

  async confirm(importId: string, actorId: string): Promise<ImportResult> {
    const job = await this.importRow(importId);
    const rowsStart = process.hrtime.bigint();
    const written = await this.dataSource.transaction(async (manager) => {
      const costCentersCreated = await this.prepareCatalogs(manager, job, actorId);
      const classified = await this.classify(manager, job);
      await manager.query('DELETE FROM staging_quarantine WHERE import_id = $1', [importId]);
      await manager.query(
        `INSERT INTO staging_quarantine (import_id, sheet_name, row_number, legacy_asset_id, reason, detail)
         SELECT $1, $2, x.row_number, x.legacy_id, x.reason, x.detail
         FROM jsonb_to_recordset($3::jsonb) AS x(row_number int, legacy_id text, reason text, detail text)`,
        [importId, job.sheet_name, JSON.stringify(classified.reasons)],
      );
      const inserted =
        job.target === 'ASSETS'
          ? await this.insertAssets(manager, job, actorId)
          : job.target === 'PERSONS'
            ? await this.insertPersons(manager, job, actorId)
            : await this.insertCostCenters(manager, job);
      return { classified, inserted, costCentersCreated };
    });
    const rowsSeconds = seconds(rowsStart);

    const movementsStart = process.hrtime.bigint();
    const registrations = job.target === 'ASSETS' ? await this.registerMovements(job, actorId) : 0;
    const movementsSeconds = seconds(movementsStart);

    const result: ImportResult = {
      inserted: written.inserted,
      skippedAlreadyPresent: written.classified.alreadyPresent,
      quarantined: written.classified.quarantined,
      costCentersCreated: written.costCentersCreated,
      registrationMovements: registrations,
      seconds: { rows: rowsSeconds, movements: movementsSeconds },
    };
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE staging_import SET status = 'CONFIRMED', confirmed_at = coalesce(confirmed_at, NOW()), result = $2
         WHERE id = $1`,
        [importId, JSON.stringify(result)],
      );
      await this.auditLogsRepository.record(
        {
          action: AuditAction.AssetImported,
          entityType: 'STAGING_IMPORT',
          entityId: importId,
          performedBy: actorId,
          ipAddress: null,
          userAgent: null,
          changes: { target: job.target, ...result },
        },
        manager,
      );
    });
    return result;
  }

  async reconcile(importId: string): Promise<ReadonlyArray<ReconciliationRow>> {
    const job = await this.importRow(importId);
    if (job.target !== 'ASSETS') {
      return [];
    }
    const idColumn = col(job.mapping, 'legacyAssetId');
    const legacyIds = `SELECT ${idColumn} FROM staging_row r
      WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 AND ${idColumn} IS NOT NULL`;
    const params = [job.batch_id, job.sheet_name, job.header_row, importId];
    const [base] = (await this.dataSource.query(
      `SELECT
         (SELECT count(*) FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3)::int AS read,
         (SELECT count(*) FROM staging_issue WHERE import_id = $4 AND issue_code IN ('EMPTY_ROW', 'ROW_WITHOUT_ASSET_ID'))::int AS not_assets,
         (SELECT count(*) FROM asset_import_origin WHERE legacy_asset_id IN (${legacyIds}))::int AS in_model,
         (SELECT count(*) FROM staging_quarantine WHERE import_id = $4)::int AS quarantined,
         (SELECT count(*) FROM staging_quarantine WHERE import_id = $4
            AND reason NOT IN ('EMPTY_ROW', 'ROW_WITHOUT_ASSET_ID'))::int AS quarantined_assets`,
      params,
    )) as Array<{ read: number; not_assets: number; in_model: number; quarantined: number; quarantined_assets: number }>;
    if (!base) {
      return [];
    }
    const rows: ReconciliationRow[] = [
      reconciled('Filas leídas', base.read, base.in_model, base.quarantined),
      reconciled('Activos (filas con identidad)', base.read - base.not_assets, base.in_model, base.quarantined_assets),
    ];
    for (const [label, codes, flag] of RECONCILED_FLAGS) {
      const [counts] = (await this.dataSource.query(
        `SELECT
           (SELECT count(*) FROM staging_issue WHERE import_id = $4 AND issue_code = ANY($5))::int AS diagnostic,
           (SELECT count(*) FROM asset_import_origin o JOIN asset a ON a.id = o.asset_id
              WHERE o.legacy_asset_id IN (${legacyIds}) AND $6 = ANY(a.data_quality_flags))::int AS model,
           (SELECT count(DISTINCT i.row_number) FROM staging_issue i
              JOIN staging_quarantine q ON q.import_id = i.import_id AND q.row_number = i.row_number
              WHERE i.import_id = $4 AND i.issue_code = ANY($5))::int AS quarantined`,
        [...params, codes, flag],
      )) as Array<{ diagnostic: number; model: number; quarantined: number }>;
      if (counts) {
        rows.push(reconciled(label, counts.diagnostic, counts.model, counts.quarantined));
      }
    }
    const [derived] = (await this.dataSource.query(
      `WITH imported AS (SELECT asset_id FROM asset_import_origin WHERE legacy_asset_id IN (${legacyIds}))
       SELECT
         (SELECT count(*) FROM asset WHERE id IN (SELECT asset_id FROM imported) AND barcode IS NOT NULL)::int AS with_barcode,
         (SELECT count(*) FROM asset_identifier WHERE asset_id IN (SELECT asset_id FROM imported) AND identifier_type = 'LEGACY_CODE')::int AS legacy,
         (SELECT count(*) FROM asset_identifier WHERE asset_id IN (SELECT asset_id FROM imported) AND identifier_type = 'OPAQUE_ID')::int AS opaque,
         (SELECT count(*) FROM asset_identifier WHERE asset_id IN (SELECT asset_id FROM imported) AND identifier_type = 'VISIBLE_CODE')::int AS visible,
         (SELECT count(*) FROM asset_movement WHERE asset_id IN (SELECT asset_id FROM imported) AND movement_type = 'REGISTRATION')::int AS registrations`,
      [job.batch_id, job.sheet_name, job.header_row],
    )) as Array<{ with_barcode: number; legacy: number; opaque: number; visible: number; registrations: number }>;
    if (derived) {
      rows.push(
        reconciled('LEGACY_CODE = activos con código', derived.with_barcode, derived.legacy, 0),
        reconciled('OPAQUE_ID = activos en el modelo', base.in_model, derived.opaque, 0),
        reconciled('REGISTRATION = activos en el modelo', base.in_model, derived.registrations, 0),
        reconciled('VISIBLE_CODE generados (debe ser 0)', 0, derived.visible, 0),
      );
    }
    return rows;
  }

  private async validate(batchId: string, request: PreviewRequest): Promise<number> {
    const [batch] = (await this.dataSource.query(
      'SELECT sheets FROM staging_batch WHERE id = $1',
      [batchId],
    )) as Array<{ sheets: Array<{ name: string }> }>;
    if (!batch) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el archivo cargado');
    }
    if (!batch.sheets.some((sheet) => sheet.name === request.sheet)) {
      throw new ApiException(ErrorCode.ValidationFailed, `El archivo no tiene la hoja '${request.sheet}'`);
    }
    const fields: Record<string, ImportField> = fieldsFor(request.target);
    const unknown = Object.keys(request.mapping).filter((field) => !(field in fields));
    const missing = Object.entries(fields)
      .filter(([field, definition]) => definition.required && !request.mapping[field])
      .map(([field]) => field);
    const badLetters = Object.entries(request.mapping).filter(([, letter]) => !COLUMN_LETTER.test(letter));
    const rules = targetRuleErrors(request);
    if (unknown.length > 0 || missing.length > 0 || badLetters.length > 0 || rules.length > 0) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Mapeo inválido', [
        ...unknown.map((field) => ({ field, message: 'Campo destino desconocido' })),
        ...missing.map((field) => ({ field, message: 'Campo obligatorio sin columna asignada' })),
        ...badLetters.map(([field]) => ({ field, message: 'Columna inválida' })),
        ...rules,
      ]);
    }
    if (request.headerRow !== undefined) {
      return request.headerRow;
    }
    const head = (await this.dataSource.query(
      `SELECT row_number, cells, cell_types FROM staging_row
       WHERE batch_id = $1 AND sheet_name = $2 AND row_number <= 30 ORDER BY row_number`,
      [batchId, request.sheet],
    )) as Array<{ row_number: number; cells: Record<string, RawCellValue>; cell_types: Record<string, string> }>;
    return detectHeaderRow(head.map((row) => ({ rowNumber: row.row_number, cells: row.cells, types: row.cell_types })));
  }

  private async importRow(importId: string): Promise<ImportRow> {
    const [row] = (await this.dataSource.query(
      `SELECT i.*, b.file_name FROM staging_import i JOIN staging_batch b ON b.id = i.batch_id WHERE i.id = $1`,
      [importId],
    )) as ImportRow[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la importación');
    }
    return row;
  }

  private async prepareCatalogs(
    manager: EntityManager,
    job: ImportRow,
    actorId: string | null,
  ): Promise<number> {
    if (job.target !== 'ASSETS') {
      return 0;
    }
    await manager.query(
      `INSERT INTO asset_category (code, name, description, requires_photo, hierarchy_path)
       VALUES ($1, 'Sin clasificar', 'Activos importados sin categoría; reclasificar', FALSE, '/sin_clasificar')
       ON CONFLICT (code) DO NOTHING`,
      [PLACEHOLDER_CATEGORY],
    );
    await manager.query(
      `INSERT INTO acquisition_type (code, name) VALUES ($1, 'No registrado') ON CONFLICT (code) DO NOTHING`,
      [PLACEHOLDER_ACQUISITION_TYPE],
    );
    if (job.options.unknownCostCenters !== 'create') {
      return 0;
    }
    const created = (await manager.query(
      `INSERT INTO cost_center (external_code, name, accepts_assets, is_active, sync_source, last_synced_at, external_metadata)
       SELECT DISTINCT ${col(job.mapping, 'costCenterCode')},
              'Centro ' || ${col(job.mapping, 'costCenterCode')} || ' (no está en el catálogo)',
              TRUE, TRUE, 'IMPORT_EXCEL', NOW(),
              jsonb_build_object('notInCatalog', true, 'importId', $4::text, 'createdBy', $5::text)
       FROM staging_row r
       WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3
         AND ${col(job.mapping, 'legacyAssetId')} IS NOT NULL
         AND ${col(job.mapping, 'costCenterCode')} IS NOT NULL
       ON CONFLICT (external_code) DO NOTHING
       RETURNING id`,
      [job.batch_id, job.sheet_name, job.header_row, job.id, actorId],
    )) as unknown[];
    return created.length;
  }

  private async classify(manager: EntityManager, job: ImportRow): Promise<Classified> {
    const m = job.mapping;
    if (job.target === 'PERSONS') {
      return this.classifyPersons(manager, job);
    }
    if (job.target === 'COST_CENTERS') {
      await manager.query(
        `CREATE TEMP TABLE import_src ON COMMIT DROP AS
         SELECT r.row_number, r.cells,
           NOT EXISTS (SELECT 1 FROM jsonb_each_text(r.cells) e WHERE btrim(e.value) <> '') AS is_blank,
           ${col(m, 'code')} AS code, ${col(m, 'name')} AS name, NULL::text AS reason, NULL::text AS detail
         FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3`,
        [job.batch_id, job.sheet_name, job.header_row],
      );
      await manager.query(`
        UPDATE import_src s SET reason = c.reason FROM (
          SELECT row_number, CASE
            WHEN is_blank THEN 'EMPTY_ROW'
            WHEN code IS NULL OR name IS NULL THEN 'REQUIRED_FIELD_MISSING'
            WHEN count(*) OVER (PARTITION BY code) > 1 THEN 'CODE_DUPLICATED'
          END AS reason FROM import_src) c
        WHERE s.row_number = c.row_number`);
      return this.summarize(manager, 'code', 'SELECT 1 FROM cost_center cc WHERE cc.external_code = s.code', null);
    }

    await manager.query(
      `CREATE TEMP TABLE import_src ON COMMIT DROP AS
       SELECT r.row_number, r.cells, r.cell_types,
         NOT EXISTS (SELECT 1 FROM jsonb_each_text(r.cells) e WHERE btrim(e.value) <> '') AS is_blank,
         ${col(m, 'legacyAssetId')} AS legacy_id, ${col(m, 'legacyCode')} AS barcode,
         ${col(m, 'description')} AS description, ${col(m, 'model')} AS model,
         ${col(m, 'serial')} AS serial, ${col(m, 'acquisitionDocument')} AS document,
         ${col(m, 'costCenterCode')} AS center_code,
         ${col(m, 'acquisitionDate')} AS purchase_raw, ${colType(m, 'acquisitionDate')} AS purchase_type,
         ${col(m, 'acquisitionPrice')} AS price_raw, ${col(m, 'usefulLifeYears')} AS useful_raw,
         ${col(m, 'notes')} AS notes,
         NULL::text AS reason, NULL::text AS detail, FALSE AS barcode_dup
       FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3`,
      [job.batch_id, job.sheet_name, job.header_row],
    );
    await manager.query(`
      UPDATE import_src s SET barcode_dup = TRUE FROM (
        SELECT barcode FROM import_src
        WHERE legacy_id IS NOT NULL AND barcode IS NOT NULL AND upper(barcode) <> 'TEMP'
        GROUP BY barcode HAVING count(*) > 1) d
      WHERE s.barcode = d.barcode AND s.legacy_id IS NOT NULL`);
    await manager.query(`
      UPDATE import_src s SET reason = c.reason, detail = c.detail FROM (
        SELECT row_number,
          CASE
            WHEN is_blank THEN 'EMPTY_ROW'
            WHEN legacy_id IS NULL THEN 'ROW_WITHOUT_ASSET_ID'
            WHEN count(*) OVER (PARTITION BY legacy_id) > 1 THEN 'ASSET_ID_DUPLICATED'
            WHEN description IS NULL THEN 'REQUIRED_FIELD_MISSING'
            WHEN center_code IS NULL
              OR NOT EXISTS (SELECT 1 FROM cost_center cc WHERE cc.external_code = import_src.center_code)
              THEN 'COST_CENTER_UNKNOWN'
          END AS reason,
          CASE
            WHEN center_code IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM cost_center cc WHERE cc.external_code = import_src.center_code)
              THEN 'Centro de costo ' || center_code
          END AS detail
        FROM import_src) c
      WHERE s.row_number = c.row_number`);
    return this.summarize(
      manager,
      'legacy_id',
      'SELECT 1 FROM asset_import_origin o WHERE o.legacy_asset_id = s.legacy_id',
      `
        SELECT flag AS key, count(*)::int AS count FROM (
          SELECT unnest(array_remove(ARRAY[
            CASE WHEN upper(barcode) = 'TEMP' THEN 'BARCODE_TEMP' END,
            CASE WHEN barcode_dup THEN 'BARCODE_DUPLICATED' END,
            CASE WHEN barcode IS NULL THEN 'BARCODE_EMPTY' END,
            CASE WHEN purchase_raw IS NULL THEN 'ACQUISITION_DATE_MISSING' END,
            CASE WHEN purchase_raw IS NOT NULL AND (coalesce(purchase_type, '') NOT IN ('date', 'formula:date')
              OR left(purchase_raw, 10) = '1970-01-01') THEN 'ACQUISITION_DATE_INVALID' END,
            CASE WHEN price_raw ~ '^-?[0-9]+(\\.[0-9]+)?$' AND price_raw::numeric = 0 THEN 'PRICE_ZERO' END,
            CASE WHEN price_raw IS NULL OR price_raw !~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 'PRICE_MISSING' END
          ], NULL)) AS flag
          FROM import_src s
          WHERE s.reason IS NULL AND NOT EXISTS (SELECT 1 FROM asset_import_origin o WHERE o.legacy_asset_id = s.legacy_id)
        ) f GROUP BY flag`,
    );
  }

  /**
   * Personas. El número de documento nunca sale de aquí: la cuarentena y los problemas se identifican por fila
   * (legacy_id NULL) y los detalles no lo incluyen.
   */
  private async classifyPersons(manager: EntityManager, job: ImportRow): Promise<Classified> {
    const m = job.mapping;
    const fullName = Boolean(m['fullName']);
    await manager.query(
      `CREATE TEMP TABLE import_src ON COMMIT DROP AS
       SELECT r.row_number,
         NOT EXISTS (SELECT 1 FROM jsonb_each_text(r.cells) e WHERE btrim(e.value) <> '') AS is_blank,
         ${col(m, 'documentNumber')} AS doc_number,
         ${col(m, 'documentType')} AS doc_type_raw,
         NULL::varchar(10) AS doc_type,
         ${fullName ? col(m, 'fullName') : col(m, 'firstName')} AS first_name,
         ${fullName ? "''::text" : col(m, 'lastName')} AS last_name,
         ${col(m, 'positionTitle')} AS position_title,
         ${col(m, 'email')} AS email,
         ${col(m, 'costCenterCode')} AS center_code,
         NULL::text AS reason, NULL::text AS detail
       FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3`,
      [job.batch_id, job.sheet_name, job.header_row],
    );
    await manager.query(
      `UPDATE import_src SET doc_type = coalesce($1::text,
         (SELECT a.code FROM (VALUES ${DOCUMENT_TYPE_ALIASES}) AS a(code, folded)
          WHERE a.folded = upper(regexp_replace(doc_type_raw, '[[:space:].]', '', 'g')) LIMIT 1))`,
      [job.options.declaredDocumentType ?? null],
    );
    await manager.query(`
      UPDATE import_src s SET reason = c.reason, detail = c.detail FROM (
        SELECT row_number, reason,
          CASE reason
            WHEN 'DOCUMENT_TYPE_INVALID' THEN 'Tipo de documento «' || left(doc_type_raw, 20) || '» fuera del catálogo'
            WHEN 'DOCUMENT_NUMBER_INVALID' THEN 'El número no corresponde al tipo de documento'
            WHEN 'DOCUMENT_NUMBER_DUPLICATED' THEN 'El número aparece ' || repeated || ' veces en el archivo'
            WHEN 'DOCUMENT_TYPE_CONFLICT' THEN
              CASE WHEN doc_type IS NULL
                THEN 'Ya existe una persona con ese número y tipo de documento; declare el tipo del lote'
                ELSE 'Ya existe una persona con ese número sin tipo de documento; complete su tipo antes de importar' END
            WHEN 'COST_CENTER_UNKNOWN' THEN 'Centro de costo ' || center_code
            WHEN 'FIELD_TOO_LONG' THEN 'Nombre (máx. 100) o cargo (máx. 150) demasiado largo'
          END AS detail
        FROM (
          SELECT *,
            count(*) OVER (PARTITION BY doc_number) AS repeated,
            CASE
              WHEN is_blank THEN 'EMPTY_ROW'
              WHEN doc_number IS NULL THEN 'DOCUMENT_NUMBER_MISSING'
              WHEN doc_type_raw IS NOT NULL AND doc_type IS NULL THEN 'DOCUMENT_TYPE_INVALID'
              WHEN length(doc_number) > 30
                OR (doc_type IN (${NUMERIC_DOCUMENT_TYPES}) AND doc_number !~ '^[0-9]+$') THEN 'DOCUMENT_NUMBER_INVALID'
              WHEN count(*) OVER (PARTITION BY doc_number) > 1 THEN 'DOCUMENT_NUMBER_DUPLICATED'
              WHEN first_name IS NULL OR last_name IS NULL THEN 'REQUIRED_FIELD_MISSING'
              WHEN length(first_name) > 100 OR length(last_name) > 100 OR length(position_title) > 150
                THEN 'FIELD_TOO_LONG'
              WHEN (doc_type IS NULL AND EXISTS (SELECT 1 FROM person p
                      WHERE p.document_number = import_src.doc_number AND p.document_type IS NOT NULL))
                OR (doc_type IS NOT NULL AND EXISTS (SELECT 1 FROM person p
                      WHERE p.document_number = import_src.doc_number AND p.document_type IS NULL))
                THEN 'DOCUMENT_TYPE_CONFLICT'
              WHEN center_code IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM cost_center cc WHERE cc.external_code = import_src.center_code)
                THEN 'COST_CENTER_UNKNOWN'
              WHEN email IS NULL THEN 'EMAIL_MISSING'
              WHEN email !~* '@unac\\.edu\\.co$' THEN 'EMAIL_NOT_INSTITUTIONAL'
            END AS reason
          FROM import_src) x) c
      WHERE s.row_number = c.row_number`);
    const classified = await this.summarize(
      manager,
      'NULL::text',
      PERSON_ALREADY_PRESENT,
      `
        SELECT flag AS key, count(*)::int AS count FROM (
          SELECT unnest(array_remove(ARRAY[
            CASE WHEN doc_type IS NULL THEN 'DOCUMENT_TYPE_UNKNOWN' END,
            ${fullName ? "'NAME_NOT_SPLIT'" : 'NULL'}
          ], NULL)) AS flag
          FROM import_src s WHERE s.reason IS NULL AND NOT EXISTS (${PERSON_ALREADY_PRESENT})
        ) f GROUP BY flag`,
    );
    // Conteos independientes del orden de los motivos: cada fila tiene un solo motivo de cuarentena, pero el
    // operador necesita saber cuántas no traen correo y cuántas apuntan a un centro inexistente.
    const unknownCenter =
      'center_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_center cc WHERE cc.external_code = s.center_code)';
    const [counts] = (await manager.query(`
      SELECT
        count(*) FILTER (WHERE NOT is_blank)::int AS rows,
        count(*) FILTER (WHERE NOT is_blank AND email IS NULL)::int AS without_email,
        count(*) FILTER (WHERE NOT is_blank AND doc_type IS NULL)::int AS without_type,
        count(*) FILTER (WHERE NOT is_blank AND center_code IS NULL)::int AS without_center,
        count(*) FILTER (WHERE NOT is_blank AND ${unknownCenter})::int AS unknown_center_rows,
        count(DISTINCT center_code) FILTER (WHERE ${unknownCenter})::int AS unknown_centers,
        string_agg(DISTINCT center_code, ', ' ORDER BY center_code) FILTER (WHERE ${unknownCenter}) AS unknown_codes
      FROM import_src s`)) as Array<{
      rows: number;
      without_email: number;
      without_type: number;
      without_center: number;
      unknown_center_rows: number;
      unknown_centers: number;
      unknown_codes: string | null;
    }>;
    const base = counts?.rows ?? 0;
    const typeSource = job.options.documentTypeSource;
    const metrics: Metric[] = [
      { key: 'PERSONS_WITHOUT_EMAIL', label: 'Filas sin correo', value: counts?.without_email ?? 0, base },
      {
        key: 'PERSONS_WITHOUT_DOCUMENT_TYPE',
        label: 'Filas sin tipo de documento',
        value: counts?.without_type ?? 0,
        base,
        detail:
          typeSource === 'DECLARED_BY_OPERATOR'
            ? `Tipo declarado por el operador para todo el lote: ${job.options.declaredDocumentType ?? ''}`
            : typeSource === 'COLUMN'
              ? 'Tipo tomado de la columna del archivo'
              : 'Sin columna ni tipo declarado: se guardan sin tipo, con la marca DOCUMENT_TYPE_UNKNOWN',
      },
      { key: 'PERSONS_WITHOUT_COST_CENTER', label: 'Filas sin centro de costo', value: counts?.without_center ?? 0, base },
      {
        key: 'PERSONS_COST_CENTER_UNKNOWN_ROWS',
        label: 'Filas con centro de costo inexistente',
        value: counts?.unknown_center_rows ?? 0,
        base,
      },
      {
        key: 'PERSONS_COST_CENTER_UNKNOWN',
        label: 'Centros de costo inexistentes (distintos)',
        value: counts?.unknown_centers ?? 0,
        base: null,
        ...(counts?.unknown_codes ? { detail: counts.unknown_codes } : {}),
      },
    ];
    return { ...classified, metrics };
  }

  private async insertPersons(manager: EntityManager, job: ImportRow, actorId: string): Promise<number> {
    const fullName = Boolean(job.mapping['fullName']);
    const source = job.options.documentTypeSource === 'DECLARED_BY_OPERATOR' ? 'DECLARED_BY_OPERATOR' : 'COLUMN';
    const [row] = (await manager.query(
      `WITH src AS (
         SELECT s.*, cc.id AS cost_center_id
         FROM import_src s LEFT JOIN cost_center cc ON cc.external_code = s.center_code
         WHERE s.reason IS NULL AND NOT EXISTS (${PERSON_ALREADY_PRESENT})
       ),
       inserted AS (
         INSERT INTO person (document_type, document_number, first_name, last_name, email, position_title,
           cost_center_id, data_quality_flags)
         SELECT src.doc_type, src.doc_number, src.first_name, src.last_name, src.email, src.position_title,
           src.cost_center_id,
           array_remove(ARRAY[
             CASE WHEN src.doc_type IS NULL THEN 'DOCUMENT_TYPE_UNKNOWN' END,
             ${fullName ? "'NAME_NOT_SPLIT'" : 'NULL'}
           ], NULL)::varchar(40)[]
         FROM src
         ON CONFLICT DO NOTHING
         RETURNING id, document_type, document_number
       ),
       origin AS (
         INSERT INTO person_import_origin (person_id, import_id, source_file, sheet_name, row_number,
           document_type_source, imported_by)
         SELECT i.id, $1, $2, $3, src.row_number,
           CASE WHEN i.document_type IS NULL THEN 'UNKNOWN' ELSE $4 END, $5
         FROM inserted i
         JOIN src ON src.doc_number = i.document_number AND src.doc_type IS NOT DISTINCT FROM i.document_type
         RETURNING person_id
       )
       SELECT count(*)::int AS inserted FROM origin`,
      [job.id, job.file_name, job.sheet_name, source, actorId],
    )) as Array<{ inserted: number }>;
    return row?.inserted ?? 0;
  }

  private async summarize(
    manager: EntityManager,
    keyColumn: string,
    existsSql: string,
    flagsSql: string | null,
  ): Promise<Classified> {
    const [counts] = (await manager.query(`
      SELECT count(*)::int AS rows_read,
        count(*) FILTER (WHERE s.reason IS NULL AND NOT EXISTS (${existsSql}))::int AS to_insert,
        count(*) FILTER (WHERE s.reason IS NULL AND EXISTS (${existsSql}))::int AS already_present
      FROM import_src s`)) as Array<{ rows_read: number; to_insert: number; already_present: number }>;
    const quarantined = (await manager.query(
      `SELECT reason AS key, count(*)::int AS count FROM import_src WHERE reason IS NOT NULL GROUP BY reason`,
    )) as Array<{ key: string; count: number }>;
    const reasons = (await manager.query(
      `SELECT row_number, ${keyColumn} AS legacy_id, reason, detail FROM import_src
       WHERE reason IS NOT NULL ORDER BY row_number`,
    )) as Classified['reasons'];
    const flagged = flagsSql ? ((await manager.query(flagsSql)) as Array<{ key: string; count: number }>) : [];
    return {
      rowsRead: counts?.rows_read ?? 0,
      toInsert: counts?.to_insert ?? 0,
      alreadyPresent: counts?.already_present ?? 0,
      quarantined: countBy(quarantined),
      flagged: countBy(flagged),
      reasons,
    };
  }

  private async insertAssets(manager: EntityManager, job: ImportRow, actorId: string): Promise<number> {
    const [row] = (await manager.query(
      `WITH src AS (
         SELECT s.*,
           CASE WHEN s.purchase_type IN ('date', 'formula:date') AND left(s.purchase_raw, 10) <> '1970-01-01'
                THEN left(s.purchase_raw, 10)::date END AS purchase_date,
           CASE WHEN s.price_raw ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.price_raw::numeric END AS price,
           CASE WHEN s.useful_raw ~ '^[0-9]{1,3}(\\.0+)?$' THEN s.useful_raw::numeric::smallint END AS useful_life,
           cc.id AS cost_center_id,
           coalesce((cc.external_metadata ->> 'notInCatalog')::boolean, FALSE) AS center_not_in_catalog
         FROM import_src s JOIN cost_center cc ON cc.external_code = s.center_code
         WHERE s.reason IS NULL
           AND NOT EXISTS (SELECT 1 FROM asset_import_origin o WHERE o.legacy_asset_id = s.legacy_id)
       ),
       inserted AS (
         INSERT INTO asset (internal_code, barcode, serial_number, description, model, category_id,
           acquisition_type_id, acquisition_date, acquisition_document, acquisition_price, currency,
           operational_status, physical_condition, current_cost_center_id, depreciation_method,
           useful_life_years, salvage_value, notes, created_by, updated_by, data_quality_flags)
         SELECT 'XLS-' || src.legacy_id, left(src.barcode, 50), left(src.serial, 100), left(src.description, 500),
           left(src.model, 150), (SELECT id FROM asset_category WHERE code = $1),
           (SELECT id FROM acquisition_type WHERE code = $2), src.purchase_date,
           left(src.document, 100), coalesce(src.price, 0), 'COP', 'IN_USE', NULL,
           src.cost_center_id, 'STRAIGHT_LINE', src.useful_life, 0, src.notes, $3, $3,
           array_remove(ARRAY[
             CASE WHEN upper(src.barcode) = 'TEMP' THEN 'BARCODE_TEMP' END,
             CASE WHEN src.barcode_dup THEN 'BARCODE_DUPLICATED' END,
             CASE WHEN src.barcode IS NULL THEN 'BARCODE_EMPTY' END,
             CASE WHEN src.purchase_raw IS NULL THEN 'ACQUISITION_DATE_MISSING' END,
             CASE WHEN src.purchase_raw IS NOT NULL AND src.purchase_date IS NULL THEN 'ACQUISITION_DATE_INVALID' END,
             CASE WHEN src.price = 0 THEN 'PRICE_ZERO' END,
             CASE WHEN src.price IS NULL THEN 'PRICE_MISSING' END,
             'CATEGORY_UNASSIGNED',
             'ACQUISITION_TYPE_UNKNOWN',
             'PHYSICAL_CONDITION_UNKNOWN',
             CASE WHEN src.center_not_in_catalog THEN 'COST_CENTER_NOT_IN_CATALOG' END
           ], NULL)::varchar(40)[]
         FROM src
         RETURNING id, internal_code
       ),
       origin AS (
         INSERT INTO asset_import_origin (asset_id, legacy_asset_id, import_id, source_file, sheet_name, row_number, source_row)
         SELECT i.id, src.legacy_id, $4, $5, $6, src.row_number,
           jsonb_build_object('cells', src.cells, 'types', src.cell_types)
         FROM inserted i JOIN src ON i.internal_code = 'XLS-' || src.legacy_id
         RETURNING asset_id
       ),
       legacy AS (
         INSERT INTO asset_identifier (asset_id, identifier_type, value, origin, created_by)
         SELECT i.id, 'LEGACY_CODE', left(src.barcode, 100), 'IMPORTED', $3
         FROM inserted i JOIN src ON i.internal_code = 'XLS-' || src.legacy_id
         WHERE src.barcode IS NOT NULL
         RETURNING asset_id
       ),
       opaque AS (
         INSERT INTO asset_identifier (asset_id, identifier_type, value, origin, created_by)
         SELECT i.id, 'OPAQUE_ID', gen_random_uuid()::text, 'GENERATED', $3 FROM inserted i
         RETURNING asset_id
       )
       SELECT (SELECT count(*) FROM origin)::int AS origin,
              (SELECT count(*) FROM legacy)::int AS legacy,
              (SELECT count(*) FROM opaque)::int AS opaque`,
      [PLACEHOLDER_CATEGORY, PLACEHOLDER_ACQUISITION_TYPE, actorId, job.id, job.file_name, job.sheet_name],
    )) as Array<{ origin: number }>;
    return row?.origin ?? 0;
  }

  private async insertCostCenters(manager: EntityManager, job: ImportRow): Promise<number> {
    const inserted = (await manager.query(
      `INSERT INTO cost_center (external_code, name, accepts_assets, is_active, sync_source, last_synced_at, external_metadata)
       SELECT s.code, left(s.name, 200), TRUE, TRUE, 'IMPORT_EXCEL', NOW(),
              jsonb_build_object('importId', $1::text, 'row', s.row_number)
       FROM import_src s WHERE s.reason IS NULL
       ON CONFLICT (external_code) DO NOTHING
       RETURNING id`,
      [job.id],
    )) as unknown[];
    return inserted.length;
  }

  private async registerMovements(job: ImportRow, actorId: string): Promise<number> {
    let registered = 0;
    for (;;) {
      const pending = (await this.dataSource.query(
        `SELECT a.id, to_char(a.acquisition_date, 'YYYY-MM-DD') AS acquisition_date, o.row_number, o.legacy_asset_id
         FROM asset_import_origin o JOIN asset a ON a.id = o.asset_id
         WHERE o.import_id = $1 AND NOT EXISTS (SELECT 1 FROM asset_movement m WHERE m.asset_id = a.id)
         ORDER BY o.row_number LIMIT $2`,
        [job.id, MOVEMENT_CHUNK],
      )) as Array<{ id: string; acquisition_date: string | null; row_number: number; legacy_asset_id: string }>;
      if (pending.length === 0) {
        return registered;
      }
      await this.dataSource.transaction(async (manager) => {
        for (const asset of pending) {
          await this.assetState.apply(
            {
              assetId: asset.id,
              actorId,
              patch: {},
              movement: {
                type: MovementType.Registration,
                initial: true,
                reason: 'Importación desde Excel',
                documentReference: `${job.file_name}#${job.sheet_name}!${asset.row_number}`.slice(0, 100),
                ...(asset.acquisition_date
                  ? { executedAt: new Date(`${asset.acquisition_date}T00:00:00.000Z`) }
                  : {}),
                metadata: {
                  source: 'EXCEL_IMPORT',
                  importId: job.id,
                  row: asset.row_number,
                  legacyAssetId: asset.legacy_asset_id,
                  executedAtKnown: asset.acquisition_date !== null,
                },
              },
            },
            manager,
          );
        }
      });
      registered += pending.length;
    }
  }

  private async diagnose(job: ImportRow) {
    const rows = (await this.dataSource.query(
      `SELECT row_number, cells, cell_types FROM staging_row
       WHERE batch_id = $1 AND sheet_name = $2 ORDER BY row_number`,
      [job.batch_id, job.sheet_name],
    )) as Array<{ row_number: number; cells: Record<string, RawCellValue>; cell_types: Record<string, string> }>;
    const header = rows.find((row) => row.row_number === job.header_row);
    const codes = (await this.dataSource.query('SELECT external_code FROM cost_center')) as Array<{
      external_code: string;
    }>;
    const mapping: Partial<Record<AssetColumn, string>> = {};
    for (const [field, definition] of Object.entries(ASSET_IMPORT_FIELDS)) {
      const letter = job.mapping[field];
      if ('diagnostic' in definition && letter) {
        mapping[definition.diagnostic] = letter;
      }
    }
    return diagnoseAssetSheet(
      {
        name: job.sheet_name,
        headerRow: job.header_row,
        columns: Object.fromEntries(
          Object.entries(header?.cells ?? {}).map(([letter, value]) => [letter, String(value)]),
        ),
        rows: rows.map((row) => ({ rowNumber: row.row_number, cells: row.cells, types: row.cell_types })),
      },
      new Set(codes.map((code) => code.external_code)),
      mapping,
    );
  }

  private async saveIssues(manager: EntityManager, job: ImportRow, issues: ReadonlyArray<Issue>) {
    await manager.query('DELETE FROM staging_issue WHERE import_id = $1', [job.id]);
    for (let start = 0; start < issues.length; start += CHUNK_SIZE) {
      await manager.query(
        `INSERT INTO staging_issue (batch_id, import_id, sheet_name, row_number, column_name, issue_code, raw_value, detail)
         SELECT $1, $2, x.sheet, x."rowNumber", x."column", x.code, x."rawValue", x.detail
         FROM jsonb_to_recordset($3::jsonb)
           AS x(sheet text, "rowNumber" int, "column" text, code text, "rawValue" text, detail text)`,
        [job.batch_id, job.id, JSON.stringify(issues.slice(start, start + CHUNK_SIZE))],
      );
    }
  }
}
