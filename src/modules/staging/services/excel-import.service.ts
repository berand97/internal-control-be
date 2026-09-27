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
import type { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import type { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { MovementsService } from '../../movements/services/movements.service.js';
import {
  type AssetColumn,
  diagnoseAssetSheet,
  type Issue,
  type Metric,
} from '../diagnostics/asset-report-diagnostics.js';
import type { RawCellValue } from '../excel/read-workbook.js';
import {
  ASSET_IMPORT_FIELDS,
  type AssetImportField,
  catalogCode,
  catalogCodeSql,
  COLUMN_LETTER,
  COST_CENTER_IMPORT_FIELDS,
  detectHeaderRow,
  fieldsFor,
  type ImportField,
  type ImportTarget,
  type ImportTransformationCode,
  isImportTarget,
  PERSON_IMPORT_FIELDS,
  recognizeColumns,
  SAMPLE_CELL_MAX,
  SAMPLE_COLUMNS_MAX,
  SAMPLE_ROWS,
  templateFields,
  type UnknownCostCenterPolicy,
  USEFUL_LIFE_PATTERN,
} from '../import/import-fields.js';
import { normalizeHeader } from '../diagnostics/asset-report-diagnostics.js';
import { PHYSICAL_CONDITIONS } from '../../assets/enums/physical-condition.enum.js';
import { CATALOG_SHEET, INSTRUCTIONS_SHEET, META_SHEET } from '../templates/import-template.js';
import { detectTemplate, type TemplateDetection } from '../templates/import-template.service.js';
import { StagingLoaderService } from './staging-loader.service.js';

export const PLACEHOLDER_CATEGORY = 'SIN_CLASIFICAR';
export const PLACEHOLDER_ACQUISITION_TYPE = 'NO_REGISTRADO';
const CHUNK_SIZE = 2000;
/**
 * Correo institucional completo (BE-06): dot-atom sin espacios ni caracteres de control y dominio exacto. El
 * anterior '@unac\.edu\.co$' solo miraba el final, así que "x@otro.com<LF>RCPT TO:<y@unac.edu.co" pasaba.
 */
const INSTITUTIONAL_MAILBOX_SQL = String.raw`'^[A-Za-z0-9_%+-]+(\.[A-Za-z0-9_%+-]+)*@unac\.edu\.co$'`;
/** Activos por transacción al registrar movimientos: acota bloqueos y da avance visible (movementsDone). */
const MOVEMENT_CHUNK = 1000;

export interface SampleRow {
  readonly rowNumber: number;
  /** Letra → valor de la celda como texto (recortado a SAMPLE_CELL_MAX caracteres, con «…» si se recortó). */
  readonly cells: Record<string, string>;
}

export interface UploadedSheet {
  readonly name: string;
  readonly rows: number;
  readonly detectedHeaderRow: number;
  readonly columns: Record<string, string>;
  /** Primeras filas con datos bajo el encabezado detectado (sin la fila de ejemplo de la plantilla). */
  readonly sampleRows: ReadonlyArray<SampleRow>;
}

const sampleCell = (value: RawCellValue): string => {
  const text = String(value);
  return text.length > SAMPLE_CELL_MAX ? `${text.slice(0, SAMPLE_CELL_MAX - 1)}…` : text;
};

/**
 * Campos que el importador recorta al guardar (left() en el INSERT) y la columna de import_src que los lleva. La
 * vista previa cuenta con esta misma lista lo que el INSERT va a recortar.
 */
const ASSET_SRC_COLUMN: Partial<Record<AssetImportField, string>> = {
  legacyCode: 'barcode',
  serial: 'serial',
  description: 'description',
  model: 'model',
  acquisitionDocument: 'document',
};

interface Truncation {
  readonly field: string;
  readonly column: string;
  readonly length: number;
}

const assetTruncations: ReadonlyArray<Truncation> = Object.entries(ASSET_SRC_COLUMN).flatMap(([field, column]) => {
  const limit = (ASSET_IMPORT_FIELDS as Record<string, ImportField>)[field]?.maxLength;
  return limit?.over === 'TRUNCATE' && column ? [{ field, column, length: limit.length }] : [];
});

/** Largo al que el INSERT recorta un campo de activos (el mismo que cuenta la vista previa). */
const assetMax = (field: AssetImportField): number => {
  const truncation = assetTruncations.find((item) => item.field === field);
  if (!truncation) {
    throw new Error(`El campo ${field} no tiene largo máximo`);
  }
  return truncation.length;
};

const COST_CENTER_NAME_MAX = COST_CENTER_IMPORT_FIELDS.name.maxLength.length;
const PERSON_NAME_MAX = PERSON_IMPORT_FIELDS.firstName.maxLength.length;
const PERSON_LAST_NAME_MAX = PERSON_IMPORT_FIELDS.lastName.maxLength.length;
const PERSON_POSITION_MAX = PERSON_IMPORT_FIELDS.positionTitle.maxLength.length;
const PERSON_DOCUMENT_MAX = PERSON_IMPORT_FIELDS.documentNumber.maxLength.length;

/** Lo que el importador va a transformar sin avisar de otro modo, por campo (summary.transformations). */
export interface ImportTransformation {
  readonly code: ImportTransformationCode;
  readonly field: string;
  readonly label: string;
  readonly rows: number;
  /** VALUE_TRUNCATED: caracteres que se guardan. USEFUL_LIFE_DISCARDED: null. */
  readonly limit: number | null;
}

interface TransformedRow {
  readonly row_number: number;
  readonly code: ImportTransformationCode;
  readonly field: string;
  readonly length: number | null;
  readonly limit: number | null;
  readonly raw: string | null;
}

/** Columna de la plantilla que el archivo no trae (plantilla de otra versión o columna borrada). */
export interface MissingTemplateColumn {
  readonly field: string;
  readonly header: string;
  /** En la plantilla es obligatoria: sin ella cada fila va a cuarentena. */
  readonly required: boolean;
}

/** Plantilla reconocida al subir el archivo: destino, versión y mapeo automático por encabezados. */
export interface UploadedTemplate {
  readonly target: string;
  readonly version: string;
  readonly currentVersion: string | null;
  readonly outdated: boolean;
  readonly knownVersion: boolean;
  readonly versionGeneratedAt: string | null;
  readonly dataSheet: string;
  readonly headerRow: number;
  readonly mapping: Record<string, string>;
  readonly missingColumns: ReadonlyArray<MissingTemplateColumn>;
}

/** Uso de plantilla de una vista previa (null si el archivo no viene de una plantilla). */
export interface TemplateUsage {
  readonly target: string;
  readonly version: string;
  readonly currentVersion: string | null;
  readonly outdated: boolean;
  readonly knownVersion: boolean;
  readonly versionGeneratedAt: string | null;
  readonly missingColumns: ReadonlyArray<MissingTemplateColumn>;
  readonly exampleRowsIgnored: ReadonlyArray<number>;
}

export interface UnmappedColumn {
  readonly column: string;
  readonly header: string;
}

const TEMPLATE_INTERNAL_SHEETS: ReadonlySet<string> = new Set([META_SHEET, CATALOG_SHEET, INSTRUCTIONS_SHEET]);

type StagedHead = Array<{ row_number: number; cells: Record<string, RawCellValue>; cell_types: Record<string, string> }>;

const headerColumns = (cells: Record<string, RawCellValue> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(cells ?? {}).map(([letter, value]) => [letter, String(value)]));

/** La plantilla detectada aplica a esta hoja y destino. */
const templateApplies = (detection: TemplateDetection | null, sheet: string, target: ImportTarget): boolean =>
  detection !== null && detection.dataSheet === sheet && detection.target === target;

/**
 * Campos de la plantilla vigente cuyo encabezado no está en el archivo y que no se mapearon: con una plantilla de
 * otra versión (o una columna borrada) se tratan como vacíos; las reglas de cada fila siguen aplicando.
 */
const missingTemplateColumns = (
  target: ImportTarget,
  columns: Record<string, string>,
  mapping: Record<string, string>,
): MissingTemplateColumn[] => {
  const present = new Set(Object.values(columns).map(normalizeHeader));
  return templateFields(target)
    .filter(([field, definition]) => !mapping[field] && !present.has(normalizeHeader(definition.header)))
    .map(([field, definition]) => ({
      field,
      header: definition.header,
      required: definition.whenEmpty.effect === 'QUARANTINE',
    }));
};

const PHYSICAL_CONDITION_LIST = PHYSICAL_CONDITIONS.map((code) => `'${code}'`).join(', ');

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
  /** Columnas con encabezado que no quedaron asignadas a ningún campo: se ignoran, no se guardan. */
  readonly unmappedColumns: ReadonlyArray<UnmappedColumn>;
  readonly template: TemplateUsage | null;
  readonly rowsRead: number;
  readonly toInsert: number;
  readonly alreadyPresent: number;
  readonly quarantined: Record<string, number>;
  readonly flagged: Record<string, number>;
  /** Datos que se importan cambiados (texto recortado, vida útil descartada): cuántas filas, en qué campo. */
  readonly transformations: ReadonlyArray<ImportTransformation>;
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

/** Lo que dejó la fase de filas (writeRows). Se guarda en el trabajo para que un reintento no lo recalcule. */
export interface ImportRowsResult {
  readonly target: ImportTarget;
  readonly inserted: number;
  readonly skippedAlreadyPresent: number;
  readonly quarantined: Record<string, number>;
  readonly costCentersCreated: number;
  /** ASSETS: activos de esta importación aún sin movimiento REGISTRATION. */
  readonly pendingMovements: number;
  readonly seconds: number;
}

export interface MovementChunkHooks {
  /** Primera sentencia de la transacción de cada lote. */
  readonly begin: (manager: EntityManager) => Promise<void>;
  /** Última sentencia de la transacción de cada lote, con los movimientos escritos en él. */
  readonly done: (manager: EntityManager, written: number) => Promise<void>;
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
  /** Versión de la plantilla detectada en el archivo; null si no viene de una plantilla. */
  readonly template_version: string | null;
  /** Filas idénticas a la fila de ejemplo de la plantilla: no se clasifican ni se importan. */
  readonly template_example_rows: number[];
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

/**
 * Excluye las filas de ejemplo de la plantilla (enteros leídos de staging_import.template_example_rows, así que se
 * pueden escribir en el SQL). Alias de staging_row: r.
 */
const notExampleRow = (job: { readonly template_example_rows?: ReadonlyArray<number> | null }): string => {
  const rows = (job.template_example_rows ?? []).filter((row) => Number.isInteger(row));
  return rows.length > 0 ? `AND NOT (r.row_number = ANY('{${rows.join(',')}}'::int[]))` : '';
};

const countBy = (rows: ReadonlyArray<{ key: string; count: number }>): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));

/**
 * Reglas del mapeo que dependen del destino. PERSONS: el nombre va en una columna (fullName) o en dos
 * (firstName + lastName); el tipo de documento sale de una columna o lo declara el operador, no de ambas; un
 * centro de costo inexistente siempre va a cuarentena (no se crea).
 */
const targetRuleErrors = (
  request: PreviewRequest,
  /** Campos de una plantilla detectada que el archivo no trae: se tratan como vacíos, no invalidan el mapeo. */
  absent: ReadonlySet<string> = new Set(),
): Array<{ field: string; message: string }> => {
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
  const nameAbsentFromTemplate =
    !m['fullName'] &&
    ['firstName', 'lastName'].some((field) => !m[field]) &&
    ['firstName', 'lastName'].every((field) => m[field] || absent.has(field));
  if (!m['fullName'] && !(m['firstName'] && m['lastName']) && !nameAbsentFromTemplate) {
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

/** Nombre de la persona: una columna (fullName) o dos (firstName + lastName); targetRuleErrors lo valida junto. */
const PERSON_NAME_FIELDS: ReadonlySet<string> = new Set(['fullName', 'firstName', 'lastName']);

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
    private readonly movements: MovementsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async upload(
    content: Buffer,
    fileName: string,
    actorId: string | null,
  ): Promise<{
    readonly batchId: string;
    readonly created: boolean;
    readonly sheets: ReadonlyArray<UploadedSheet>;
    readonly template: UploadedTemplate | null;
  }> {
    const loaded = await this.loader.loadBuffer(content, fileName, 'UPLOAD', actorId);
    const detection = await detectTemplate(this.dataSource, loaded.batchId);
    const sheets: UploadedSheet[] = [];
    for (const sheet of loaded.sheets) {
      // Las hojas propias de la plantilla (instrucciones, catálogos, metadatos) no son datos a importar.
      if (detection && TEMPLATE_INTERNAL_SHEETS.has(sheet.name)) {
        continue;
      }
      const head = (await this.dataSource.query(
        `SELECT row_number, cells, cell_types FROM staging_row
         WHERE batch_id = $1 AND sheet_name = $2 AND row_number <= 30 ORDER BY row_number`,
        [loaded.batchId, sheet.name],
      )) as StagedHead;
      const headerRow =
        detection?.dataSheet === sheet.name
          ? detection.headerRow
          : detectHeaderRow(head.map((row) => ({ rowNumber: row.row_number, cells: row.cells, types: row.cell_types })));
      const header = head.find((row) => row.row_number === headerRow);
      const columns = headerColumns(header?.cells);
      const example =
        detection?.dataSheet === sheet.name && Object.keys(detection.example).length > 0
          ? JSON.stringify(detection.example)
          : null;
      sheets.push({
        name: sheet.name,
        rows: sheet.rows,
        detectedHeaderRow: headerRow,
        columns,
        sampleRows: await this.sampleRows(loaded.batchId, sheet.name, headerRow, columns, example),
      });
    }
    let template: UploadedTemplate | null = null;
    if (detection) {
      const data = sheets.find((sheet) => sheet.name === detection.dataSheet);
      const target = isImportTarget(detection.target) ? detection.target : null;
      const mapping = target && data ? recognizeColumns(target, data.columns) : {};
      template = {
        target: detection.target,
        version: detection.version,
        currentVersion: detection.currentVersion,
        outdated: detection.outdated,
        knownVersion: detection.knownVersion,
        versionGeneratedAt: detection.versionGeneratedAt,
        dataSheet: detection.dataSheet,
        headerRow: detection.headerRow,
        mapping,
        missingColumns: target && data ? missingTemplateColumns(target, data.columns, mapping) : [],
      };
    }
    return { batchId: loaded.batchId, created: loaded.created, sheets, template };
  }

  /**
   * Muestra de la hoja para ver el mapeo aplicado a datos reales: las primeras SAMPLE_ROWS filas con algún valor
   * bajo el encabezado, sin la fila de ejemplo de la plantilla, leídas de staging (no se relee el archivo). Solo las
   * columnas con encabezado y cada celda recortada. Ver SAMPLE_ROWS: no se guarda ni se registra en ningún lado.
   */
  private async sampleRows(
    batchId: string,
    sheet: string,
    headerRow: number,
    columns: Record<string, string>,
    example: string | null,
  ): Promise<SampleRow[]> {
    const letters = Object.keys(columns).slice(0, SAMPLE_COLUMNS_MAX);
    if (letters.length === 0) {
      return [];
    }
    const rows = (await this.dataSource.query(
      `SELECT r.row_number, r.cells FROM staging_row r
       WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3
         AND EXISTS (SELECT 1 FROM jsonb_each_text(r.cells) e WHERE btrim(e.value) <> '')
         AND ($4::jsonb IS NULL OR r.cells <> $4::jsonb)
       ORDER BY r.row_number LIMIT $5`,
      [batchId, sheet, headerRow, example, SAMPLE_ROWS],
    )) as Array<{ row_number: number; cells: Record<string, RawCellValue> }>;
    return rows.map((row) => ({
      rowNumber: row.row_number,
      cells: Object.fromEntries(
        letters.flatMap((letter) => {
          const value = row.cells[letter];
          return value === undefined ? [] : [[letter, sampleCell(value)]];
        }),
      ),
    }));
  }

  async preview(
    batchId: string,
    request: PreviewRequest,
    actorId: string | null,
  ): Promise<{ readonly importId: string; readonly summary: ImportSummary }> {
    const detection = await detectTemplate(this.dataSource, batchId);
    const { headerRow, columns } = await this.validate(batchId, request, detection);
    const applies = templateApplies(detection, request.sheet, request.target);
    const exampleRows =
      detection && detection.dataSheet === request.sheet && Object.keys(detection.example).length > 0
        ? (
            (await this.dataSource.query(
              `SELECT row_number FROM staging_row
               WHERE batch_id = $1 AND sheet_name = $2 AND row_number > $3 AND cells = $4::jsonb ORDER BY row_number`,
              [batchId, request.sheet, headerRow, JSON.stringify(detection.example)],
            )) as Array<{ row_number: number }>
          ).map((row) => row.row_number)
        : [];
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
      `INSERT INTO staging_import (batch_id, sheet_name, header_row, target, mapping, options, created_by,
         template_version, template_example_rows)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::int[]) RETURNING id`,
      [
        batchId,
        request.sheet,
        headerRow,
        request.target,
        JSON.stringify(request.mapping),
        JSON.stringify(options),
        actorId,
        detection?.version ?? null,
        exampleRows,
      ],
    )) as Array<{ id: string }>;
    const importId = created?.id ?? '';
    const job = await this.importRow(importId);

    let classified: Classified | null = null;
    let transformed: TransformedRow[] = [];
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.prepareCatalogs(manager, job, actorId);
        classified = await this.classify(manager, job);
        transformed = await this.transformations(manager, job);
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
    const definitions: Record<string, ImportField> = fieldsFor(job.target);
    const labelOf = (field: string): string => definitions[field]?.label ?? field;
    for (const row of transformed) {
      const letter = job.mapping[row.field];
      issues.push({
        sheet: job.sheet_name,
        rowNumber: row.row_number,
        column: (letter ? columns[letter] : undefined) ?? definitions[row.field]?.header ?? row.field,
        code: row.code,
        rawValue: row.code === 'USEFUL_LIFE_DISCARDED' ? row.raw : null,
        detail:
          row.code === 'VALUE_TRUNCATED'
            ? `${labelOf(row.field)}: ${row.length ?? '?'} caracteres; se guardan los primeros ${row.limit ?? '?'}`
            : `${labelOf(row.field)}: no es un número entero de años; el activo se importa sin vida útil`,
      });
    }
    const transformations: ImportTransformation[] = [];
    for (const row of transformed) {
      const existing = transformations.findIndex((item) => item.code === row.code && item.field === row.field);
      if (existing >= 0) {
        const item = transformations[existing] as ImportTransformation;
        transformations[existing] = { ...item, rows: item.rows + 1 };
      } else {
        transformations.push({ code: row.code, field: row.field, label: labelOf(row.field), rows: 1, limit: row.limit });
      }
    }
    const mappedLetters = new Set(Object.values(request.mapping));
    const unmappedColumns: UnmappedColumn[] = Object.entries(columns)
      .filter(([letter, header]) => header.trim() !== '' && !mappedLetters.has(letter))
      .map(([letter, header]) => ({ column: letter, header }));
    const missingColumns = applies ? missingTemplateColumns(request.target, columns, request.mapping) : [];
    const template: TemplateUsage | null = detection
      ? {
          target: detection.target,
          version: detection.version,
          currentVersion: detection.currentVersion,
          outdated: detection.outdated,
          knownVersion: detection.knownVersion,
          versionGeneratedAt: detection.versionGeneratedAt,
          missingColumns,
          exampleRowsIgnored: exampleRows,
        }
      : null;
    const fileIssue = (code: string, column: string | null, detail: string, rowNumber: number | null = null): Issue => ({
      sheet: job.sheet_name,
      rowNumber,
      column,
      code,
      rawValue: null,
      detail,
    });
    const templateIssues: Issue[] = [
      ...(detection?.outdated
        ? [
            fileIssue(
              'TEMPLATE_OUTDATED',
              null,
              `Plantilla de la versión ${detection.version}${detection.versionGeneratedAt ? ` (generada ${detection.versionGeneratedAt.slice(0, 10)})` : ''}; la vigente es ${detection.currentVersion ?? '—'}. Las columnas que no trae se tratan como vacías.`,
            ),
          ]
        : []),
      ...(detection && detection.target !== request.target
        ? [fileIssue('TEMPLATE_TARGET_MISMATCH', null, `La plantilla es de ${detection.target}; se importa como ${request.target}`)]
        : []),
      ...missingColumns.map((missing) =>
        fileIssue(
          'TEMPLATE_COLUMN_MISSING',
          missing.header,
          missing.required
            ? 'El archivo no trae esta columna obligatoria: se trata como vacía y cada fila va a cuarentena'
            : 'El archivo no trae esta columna: se trata como vacía',
        ),
      ),
      ...unmappedColumns.map((unmapped) =>
        fileIssue('COLUMN_UNMAPPED', unmapped.header, `Columna ${unmapped.column} sin campo asignado: se ignora, no se guarda`),
      ),
      ...exampleRows.map((row) =>
        fileIssue('TEMPLATE_EXAMPLE_ROW_IGNORED', null, 'Fila de ejemplo de la plantilla: no se importa', row),
      ),
    ];
    issues.unshift(...templateIssues);
    const summary: ImportSummary = {
      unmappedColumns,
      template,
      rowsRead: result.rowsRead,
      toInsert: result.toInsert,
      alreadyPresent: result.alreadyPresent,
      quarantined: result.quarantined,
      flagged: result.flagged,
      transformations,
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

  /**
   * Fase de filas de una importación confirmada (la corre el worker de ImportJobsService, nunca la petición HTTP).
   * Va dentro de la transacción de quien llama, que también registra el avance del trabajo: si algo falla no queda
   * nada a medias. Idempotente: lo que ya existe se omite.
   */
  async writeRows(manager: EntityManager, importId: string, actorId: string): Promise<ImportRowsResult> {
    const job = await this.importRow(importId);
    const rowsStart = process.hrtime.bigint();
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
    const [pending] =
      job.target === 'ASSETS'
        ? ((await manager.query(
            `SELECT count(*)::int AS count FROM asset_import_origin o
             WHERE o.import_id = $1 AND NOT EXISTS (SELECT 1 FROM asset_movement m WHERE m.asset_id = o.asset_id)`,
            [importId],
          )) as Array<{ count: number }>)
        : [];
    return {
      target: job.target,
      inserted,
      skippedAlreadyPresent: classified.alreadyPresent,
      quarantined: classified.quarantined,
      costCentersCreated,
      pendingMovements: pending?.count ?? 0,
      seconds: seconds(rowsStart),
    };
  }

  /** Cierre de la importación: CONFIRMED con su resultado y auditoría, en la transacción de quien llama. */
  async markConfirmed(manager: EntityManager, importId: string, actorId: string, result: ImportResult): Promise<void> {
    const job = await this.importRow(importId);
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
  }

  async reconcile(importId: string): Promise<ReadonlyArray<ReconciliationRow>> {
    const job = await this.importRow(importId);
    if (job.target !== 'ASSETS') {
      return [];
    }
    const idColumn = col(job.mapping, 'legacyAssetId');
    const notExample = notExampleRow(job);
    const legacyIds = `SELECT ${idColumn} FROM staging_row r
      WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 AND ${idColumn} IS NOT NULL ${notExample}`;
    const params = [job.batch_id, job.sheet_name, job.header_row, importId];
    const [base] = (await this.dataSource.query(
      `SELECT
         (SELECT count(*) FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 ${notExample})::int AS read,
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

  /**
   * Valida el mapeo y devuelve la fila de encabezados y sus columnas. Con una plantilla detectada (misma hoja y
   * destino), un campo obligatorio cuya columna el archivo no trae (plantilla de otra versión) no invalida el mapeo:
   * se trata como vacío y cada fila sigue su regla (va a cuarentena). En un Excel cualquiera, igual que siempre.
   */
  private async validate(
    batchId: string,
    request: PreviewRequest,
    detection: TemplateDetection | null,
  ): Promise<{ readonly headerRow: number; readonly columns: Record<string, string> }> {
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
    const applies = templateApplies(detection, request.sheet, request.target);
    let headerRow = request.headerRow;
    if (headerRow === undefined) {
      if (applies && detection) {
        headerRow = detection.headerRow;
      } else {
        const head = (await this.dataSource.query(
          `SELECT row_number, cells, cell_types FROM staging_row
           WHERE batch_id = $1 AND sheet_name = $2 AND row_number <= 30 ORDER BY row_number`,
          [batchId, request.sheet],
        )) as StagedHead;
        headerRow = detectHeaderRow(head.map((row) => ({ rowNumber: row.row_number, cells: row.cells, types: row.cell_types })));
      }
    }
    const [header] = (await this.dataSource.query(
      'SELECT cells FROM staging_row WHERE batch_id = $1 AND sheet_name = $2 AND row_number = $3',
      [batchId, request.sheet, headerRow],
    )) as Array<{ cells: Record<string, RawCellValue> }>;
    const columns = headerColumns(header?.cells);
    const absent = new Set(
      applies ? missingTemplateColumns(request.target, columns, request.mapping).map((column) => column.field) : [],
    );

    const fields: Record<string, ImportField> = fieldsFor(request.target);
    const unknown = Object.keys(request.mapping).filter((field) => !(field in fields));
    const missing = Object.entries(fields)
      .filter(([field, definition]) => definition.required && !request.mapping[field] && !absent.has(field))
      .map(([field]) => field);
    // Un campo cuya celda vacía manda la fila a cuarentena, sin columna asignada, deja fuera el 100 % de las filas:
    // eso no es un aviso sino un error del mapeo. El nombre de las personas se valida como grupo en targetRuleErrors;
    // una columna que falta en una plantilla detectada sigue la regla de las obligatorias (se trata como vacía).
    const rejectsEveryRow = Object.entries(fields)
      .filter(
        ([field, definition]) =>
          !definition.required &&
          definition.whenEmpty.effect === 'QUARANTINE' &&
          !request.mapping[field] &&
          !absent.has(field) &&
          !(request.target === 'PERSONS' && PERSON_NAME_FIELDS.has(field)),
      )
      .map(([field, definition]) => ({
        field,
        message: `Asigne la columna de «${definition.header}»: sin ese dato ninguna fila se importa. Si el archivo no la trae, agréguela y vuelva a subirlo.`,
      }));
    const badLetters = Object.entries(request.mapping).filter(([, letter]) => !COLUMN_LETTER.test(letter));
    const rules = targetRuleErrors(request, absent);
    if (
      unknown.length > 0 ||
      missing.length > 0 ||
      rejectsEveryRow.length > 0 ||
      badLetters.length > 0 ||
      rules.length > 0
    ) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Mapeo inválido', [
        ...unknown.map((field) => ({ field, message: 'Campo destino desconocido' })),
        ...missing.map((field) => ({ field, message: 'Campo obligatorio sin columna asignada' })),
        ...rejectsEveryRow,
        ...badLetters.map(([field]) => ({ field, message: 'Columna inválida' })),
        ...rules,
      ]);
    }
    return { headerRow, columns };
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
    const centerCode = catalogCodeSql(col(job.mapping, 'costCenterCode'));
    const created = (await manager.query(
      `INSERT INTO cost_center (external_code, name, accepts_assets, is_active, sync_source, last_synced_at, external_metadata)
       SELECT DISTINCT ${centerCode},
              'Centro ' || ${centerCode} || ' (no está en el catálogo)',
              TRUE, TRUE, 'IMPORT_EXCEL', NOW(),
              jsonb_build_object('notInCatalog', true, 'importId', $4::text, 'createdBy', $5::text)
       FROM staging_row r
       WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 ${notExampleRow(job)}
         AND ${col(job.mapping, 'legacyAssetId')} IS NOT NULL
         AND ${centerCode} IS NOT NULL
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
         FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 ${notExampleRow(job)}`,
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
         ${catalogCodeSql(col(m, 'costCenterCode'))} AS center_code,
         ${catalogCodeSql(col(m, 'categoryCode'))} AS category_code,
         upper(${catalogCodeSql(col(m, 'physicalCondition'))}) AS physical_condition,
         ${col(m, 'acquisitionDate')} AS purchase_raw, ${colType(m, 'acquisitionDate')} AS purchase_type,
         ${col(m, 'acquisitionPrice')} AS price_raw, ${col(m, 'usefulLifeYears')} AS useful_raw,
         ${col(m, 'notes')} AS notes,
         NULL::text AS reason, NULL::text AS detail, FALSE AS barcode_dup
       FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 ${notExampleRow(job)}`,
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
            WHEN category_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM asset_category ac
                WHERE ac.code = import_src.category_code AND ac.is_active)
              THEN 'CATEGORY_UNKNOWN'
            WHEN physical_condition IS NOT NULL AND physical_condition NOT IN (${PHYSICAL_CONDITION_LIST})
              THEN 'PHYSICAL_CONDITION_INVALID'
          END AS reason,
          CASE
            WHEN center_code IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM cost_center cc WHERE cc.external_code = import_src.center_code)
              THEN 'Centro de costo ' || center_code
            WHEN category_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM asset_category ac
                WHERE ac.code = import_src.category_code AND ac.is_active)
              THEN 'Categoría ' || left(category_code, 40)
            WHEN physical_condition IS NOT NULL AND physical_condition NOT IN (${PHYSICAL_CONDITION_LIST})
              THEN 'Condición física ' || left(physical_condition, 40)
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
            CASE WHEN price_raw IS NULL OR price_raw !~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 'PRICE_MISSING' END,
            -- Las mismas condiciones que insertAssets: vacías, quedan en «Sin clasificar» / sin verificar.
            CASE WHEN category_code IS NULL THEN 'CATEGORY_UNASSIGNED' END,
            CASE WHEN physical_condition IS NULL THEN 'PHYSICAL_CONDITION_UNKNOWN' END
          ], NULL)) AS flag
          FROM import_src s
          WHERE s.reason IS NULL AND NOT EXISTS (SELECT 1 FROM asset_import_origin o WHERE o.legacy_asset_id = s.legacy_id)
        ) f GROUP BY flag`,
    );
  }

  /**
   * Lo que el INSERT va a cambiar de filas que sí se importan, fila por fila: texto recortado (mismos largos que
   * los left() de insertAssets / insertCostCenters) y vida útil descartada (misma expresión que insertAssets). Corre
   * sobre import_src ya clasificada, con el mismo filtro de filas que el INSERT. Sin valores de las celdas salvo la
   * vida útil descartada (un número, útil para corregirlo).
   */
  private async transformations(manager: EntityManager, job: ImportRow): Promise<TransformedRow[]> {
    if (job.target === 'PERSONS') {
      // En personas un texto largo no se recorta: la fila va a cuarentena (FIELD_TOO_LONG / DOCUMENT_NUMBER_INVALID).
      return [];
    }
    const truncations: ReadonlyArray<Truncation> =
      job.target === 'ASSETS'
        ? assetTruncations
        : [{ field: 'name', column: 'name', length: COST_CENTER_NAME_MAX }];
    const insertable =
      job.target === 'ASSETS'
        ? 'NOT EXISTS (SELECT 1 FROM asset_import_origin o WHERE o.legacy_asset_id = s.legacy_id)'
        : 'NOT EXISTS (SELECT 1 FROM cost_center cc WHERE cc.external_code = s.code)';
    const checks = [
      ...truncations
        .filter((truncation) => job.mapping[truncation.field])
        .map(
          (truncation) =>
            `('VALUE_TRUNCATED', ${sqlText(truncation.field)}, length(s.${truncation.column}), ${truncation.length},
              NULL::text, length(s.${truncation.column}) > ${truncation.length})`,
        ),
      ...(job.target === 'ASSETS' && job.mapping['usefulLifeYears']
        ? [
            `('USEFUL_LIFE_DISCARDED', 'usefulLifeYears', NULL::int, NULL::int, left(s.useful_raw, 40),
              s.useful_raw IS NOT NULL AND s.useful_raw !~ '${USEFUL_LIFE_PATTERN}')`,
          ]
        : []),
    ];
    if (checks.length === 0) {
      return [];
    }
    return (await manager.query(
      `SELECT s.row_number, t.code, t.field, t.length, t."limit", t.raw
       FROM import_src s
       CROSS JOIN LATERAL (VALUES ${checks.join(',\n')}) AS t(code, field, length, "limit", raw, applies)
       WHERE s.reason IS NULL AND ${insertable} AND t.applies
       ORDER BY s.row_number, t.field`,
    )) as TransformedRow[];
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
         ${catalogCodeSql(col(m, 'documentType'))} AS doc_type_raw,
         NULL::varchar(10) AS doc_type,
         ${fullName ? col(m, 'fullName') : col(m, 'firstName')} AS first_name,
         ${fullName ? "''::text" : col(m, 'lastName')} AS last_name,
         ${col(m, 'positionTitle')} AS position_title,
         ${col(m, 'email')} AS email,
         ${catalogCodeSql(col(m, 'costCenterCode'))} AS center_code,
         NULL::text AS reason, NULL::text AS detail
       FROM staging_row r WHERE r.batch_id = $1 AND r.sheet_name = $2 AND r.row_number > $3 ${notExampleRow(job)}`,
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
            WHEN 'FIELD_TOO_LONG' THEN 'Nombre (máx. ${PERSON_NAME_MAX}) o cargo (máx. ${PERSON_POSITION_MAX}) demasiado largo'
            WHEN 'EMAIL_NOT_INSTITUTIONAL' THEN
              CASE WHEN email ~* '@unac\\.edu\\.co$'
                THEN 'El correo no es una dirección válida: tiene espacios, saltos de línea u otros caracteres no permitidos' END
          END AS detail
        FROM (
          SELECT row_number, doc_type, doc_type_raw, center_code, email,
            count(*) OVER (PARTITION BY doc_number) AS repeated,
            CASE
              WHEN is_blank THEN 'EMPTY_ROW'
              WHEN doc_number IS NULL THEN 'DOCUMENT_NUMBER_MISSING'
              WHEN doc_type_raw IS NOT NULL AND doc_type IS NULL THEN 'DOCUMENT_TYPE_INVALID'
              WHEN length(doc_number) > ${PERSON_DOCUMENT_MAX}
                OR (doc_type IN (${NUMERIC_DOCUMENT_TYPES}) AND doc_number !~ '^[0-9]+$') THEN 'DOCUMENT_NUMBER_INVALID'
              WHEN count(*) OVER (PARTITION BY doc_number) > 1 THEN 'DOCUMENT_NUMBER_DUPLICATED'
              WHEN first_name IS NULL OR last_name IS NULL THEN 'REQUIRED_FIELD_MISSING'
              WHEN length(first_name) > ${PERSON_NAME_MAX} OR length(last_name) > ${PERSON_LAST_NAME_MAX}
                OR length(position_title) > ${PERSON_POSITION_MAX}
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
              WHEN email !~* ${INSTITUTIONAL_MAILBOX_SQL} THEN 'EMAIL_NOT_INSTITUTIONAL'
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
           CASE WHEN s.useful_raw ~ '${USEFUL_LIFE_PATTERN}' THEN s.useful_raw::numeric::smallint END AS useful_life,
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
         -- Recortes: los largos de ASSET_IMPORT_FIELDS (maxLength), los mismos que cuenta la vista previa.
         SELECT 'XLS-' || src.legacy_id, left(src.barcode, ${assetMax('legacyCode')}),
           left(src.serial, ${assetMax('serial')}), left(src.description, ${assetMax('description')}),
           left(src.model, ${assetMax('model')}),
           -- Categoría y condición del archivo (ya validadas en la clasificación: fuera del catálogo va a cuarentena).
           -- Sin valor: la categoría de relleno y la condición sin verificar, con sus marcas.
           (SELECT id FROM asset_category WHERE code = coalesce(src.category_code, $1)),
           (SELECT id FROM acquisition_type WHERE code = $2), src.purchase_date,
           left(src.document, ${assetMax('acquisitionDocument')}), coalesce(src.price, 0), 'COP', 'IN_USE',
           src.physical_condition::asset_physical_condition,
           src.cost_center_id, 'STRAIGHT_LINE', src.useful_life, 0, src.notes, $3, $3,
           array_remove(ARRAY[
             CASE WHEN upper(src.barcode) = 'TEMP' THEN 'BARCODE_TEMP' END,
             CASE WHEN src.barcode_dup THEN 'BARCODE_DUPLICATED' END,
             CASE WHEN src.barcode IS NULL THEN 'BARCODE_EMPTY' END,
             CASE WHEN src.purchase_raw IS NULL THEN 'ACQUISITION_DATE_MISSING' END,
             CASE WHEN src.purchase_raw IS NOT NULL AND src.purchase_date IS NULL THEN 'ACQUISITION_DATE_INVALID' END,
             CASE WHEN src.price = 0 THEN 'PRICE_ZERO' END,
             CASE WHEN src.price IS NULL THEN 'PRICE_MISSING' END,
             CASE WHEN src.category_code IS NULL THEN 'CATEGORY_UNASSIGNED' END,
             'ACQUISITION_TYPE_UNKNOWN',
             CASE WHEN src.physical_condition IS NULL THEN 'PHYSICAL_CONDITION_UNKNOWN' END,
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
       SELECT s.code, left(s.name, ${COST_CENTER_NAME_MAX}), TRUE, TRUE, 'IMPORT_EXCEL', NOW(),
              jsonb_build_object('importId', $1::text, 'row', s.row_number)
       FROM import_src s WHERE s.reason IS NULL
       ON CONFLICT (external_code) DO NOTHING
       RETURNING id`,
      [job.id],
    )) as unknown[];
    return inserted.length;
  }

  /**
   * Movimiento REGISTRATION de cada activo importado que aún no tiene movimientos, por conjuntos: en cada lote bloquea
   * los activos (FOR UPDATE, como AssetStateService.apply), relee su estado ya bloqueado, los firma con
   * MovementsService.recordInitial (mismo esquema que record) y los inserta por lotes. Cada lote es una transacción;
   * chunk.begin / chunk.done corren dentro de ella (quien llama verifica su arrendamiento y registra el avance).
   * Idempotente: un reintento solo registra los activos que siguen sin movimiento.
   */
  async registerMovements(importId: string, actorId: string, chunk: MovementChunkHooks): Promise<number> {
    const job = await this.importRow(importId);
    let registered = 0;
    for (;;) {
      const { selected, written } = await this.dataSource.transaction(async (manager) => {
        await chunk.begin(manager);
        const locked = (await manager.query(
          `SELECT a.id FROM asset_import_origin o JOIN asset a ON a.id = o.asset_id
           WHERE o.import_id = $1 AND NOT EXISTS (SELECT 1 FROM asset_movement m WHERE m.asset_id = a.id)
           ORDER BY o.row_number LIMIT $2
           FOR UPDATE OF a`,
          [job.id, MOVEMENT_CHUNK],
        )) as Array<{ id: string }>;
        if (locked.length === 0) {
          return { selected: 0, written: 0 };
        }
        const ids = locked.map((row) => row.id);
        const pending = (await manager.query(
          `SELECT a.id, to_char(a.acquisition_date, 'YYYY-MM-DD') AS acquisition_date, o.row_number, o.legacy_asset_id,
                  a.current_cost_center_id, a.current_location_id, a.current_responsible_id,
                  a.operational_status, a.physical_condition
           FROM asset_import_origin o JOIN asset a ON a.id = o.asset_id
           WHERE a.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM asset_movement m WHERE m.asset_id = a.id)
           ORDER BY o.row_number`,
          [ids],
        )) as Array<{
          id: string;
          acquisition_date: string | null;
          row_number: number;
          legacy_asset_id: string;
          current_cost_center_id: string;
          current_location_id: string | null;
          current_responsible_id: string | null;
          operational_status: OperationalStatus;
          physical_condition: PhysicalCondition | null;
        }>;
        // Lo mismo que hacía AssetStateService.apply con patch {}: deja constancia de quién tocó el activo.
        await manager.query('UPDATE asset SET updated_by = $2, updated_at = $3 WHERE id = ANY($1::uuid[])', [
          pending.map((asset) => asset.id),
          actorId,
          new Date(),
        ]);
        const count = await this.movements.recordInitial(
          pending.map((asset) => ({
            assetId: asset.id,
            movementType: MovementType.Registration,
            fromCostCenterId: null,
            fromLocationId: null,
            fromResponsibleId: null,
            fromOperationalStatus: null,
            fromPhysicalCondition: null,
            toCostCenterId: asset.current_cost_center_id,
            toLocationId: asset.current_location_id,
            toResponsibleId: asset.current_responsible_id,
            toOperationalStatus: asset.operational_status,
            toPhysicalCondition: asset.physical_condition,
            requestedBy: actorId,
            authorizedBy: actorId,
            reason: 'Importación desde Excel',
            documentReference: `${job.file_name}#${job.sheet_name}!${asset.row_number}`.slice(0, 100),
            ...(asset.acquisition_date ? { executedAt: new Date(`${asset.acquisition_date}T00:00:00.000Z`) } : {}),
            metadata: {
              source: 'EXCEL_IMPORT',
              importId: job.id,
              row: asset.row_number,
              legacyAssetId: asset.legacy_asset_id,
              executedAtKnown: asset.acquisition_date !== null,
            },
          })),
          manager,
        );
        await chunk.done(manager, count);
        return { selected: locked.length, written: count };
      });
      if (selected === 0) {
        return registered;
      }
      registered += written;
    }
  }

  private async diagnose(job: ImportRow) {
    const rows = (await this.dataSource.query(
      `SELECT row_number, cells, cell_types FROM staging_row
       WHERE batch_id = $1 AND sheet_name = $2 ORDER BY row_number`,
      [job.batch_id, job.sheet_name],
    )) as Array<{ row_number: number; cells: Record<string, RawCellValue>; cell_types: Record<string, string> }>;
    const header = rows.find((row) => row.row_number === job.header_row);
    const examples = new Set(job.template_example_rows ?? []);
    const centerLetter = job.mapping['costCenterCode'];
    // Mismas filas y mismos códigos que la clasificación: sin la fila de ejemplo y con el código del desplegable.
    const staged = rows
      .filter((row) => !examples.has(row.row_number))
      .map((row) => {
        const center = centerLetter ? row.cells[centerLetter] : undefined;
        return typeof center === 'string'
          ? { ...row, cells: { ...row.cells, [centerLetter as string]: catalogCode(center.trim()) } }
          : row;
      });
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
        rows: staged.map((row) => ({ rowNumber: row.row_number, cells: row.cells, types: row.cell_types })),
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
