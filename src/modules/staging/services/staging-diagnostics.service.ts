import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { RawCellValue } from '../excel/read-workbook.js';
import { headerRowFor, type StagingSourceKind } from '../staging-sources.js';
import {
  ASSET_COLUMNS,
  diagnoseAssetSheet,
  findColumn,
  type Issue,
  type Metric,
  normalizeHeader,
  type StagedSheet,
} from '../diagnostics/asset-report-diagnostics.js';

const COST_CENTER_SHEET = '2026';
const COST_CENTER_CODE_HEADERS = [
  'CODIGO',
  'COD',
  'CODCENTRO',
  'CODIGOCENTRO',
  'CENTRO',
  'CENTRODECOSTO',
  'CENTRODECOSTOS',
  'IDCENTRO',
  'CC',
];
const CHUNK_SIZE = 2000;

interface SheetMeta {
  readonly name: string;
  readonly lastRow: number;
  readonly headerRow: number;
  readonly columns: Record<string, string>;
}

export interface SheetDiagnosis {
  readonly sheet: string;
  readonly metrics: ReadonlyArray<Metric>;
}

export interface SheetRelation {
  readonly left: string;
  readonly right: string;
  readonly sharedIds: number;
  readonly identicalRows: number;
  readonly commonColumns: number;
}

export interface OtherSheet {
  readonly name: string;
  readonly headerRow: number;
  readonly nonEmptyRows: number;
  readonly headers: ReadonlyArray<string>;
}

export interface AssetReportDiagnosis {
  readonly batchId: string;
  readonly sheets: ReadonlyArray<SheetDiagnosis>;
  readonly relations: ReadonlyArray<SheetRelation>;
  readonly otherSheets: ReadonlyArray<OtherSheet>;
  readonly issues: ReadonlyArray<Issue>;
}

@Injectable()
export class StagingDiagnosticsService {
  constructor(private readonly dataSource: DataSource) {}

  async diagnoseAssetReport(
    batchId: string,
    costCenterBatchId: string | null,
  ): Promise<AssetReportDiagnosis> {
    const sheets = await this.sheetsOf(batchId, 'ASSET_REPORT');
    const costCenterCodes = costCenterBatchId
      ? await this.costCenterCodes(costCenterBatchId)
      : null;

    const diagnosed: SheetDiagnosis[] = [];
    const issues: Issue[] = [];
    const staged: StagedSheet[] = [];
    const assetSheets = sheets.filter((sheet) => findColumn(sheet.columns, ASSET_COLUMNS.assetId));
    for (const meta of assetSheets) {
      const sheet = { ...meta, rows: await this.rowsOf(batchId, meta.name) };
      const result = diagnoseAssetSheet(sheet, costCenterCodes);
      staged.push(sheet);
      diagnosed.push({ sheet: meta.name, metrics: result.metrics });
      issues.push(...result.issues);
    }

    const otherSheets: OtherSheet[] = [];
    for (const meta of sheets.filter((sheet) => !assetSheets.includes(sheet))) {
      const [row] = (await this.dataSource.query(
        `SELECT count(*)::int AS count FROM staging_row
         WHERE batch_id = $1 AND sheet_name = $2 AND row_number > $3 AND cells <> '{}'::jsonb`,
        [batchId, meta.name, meta.headerRow],
      )) as Array<{ count: number }>;
      otherSheets.push({
        name: meta.name,
        headerRow: meta.headerRow,
        nonEmptyRows: row?.count ?? 0,
        headers: Object.values(meta.columns),
      });
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query('DELETE FROM staging_issue WHERE batch_id = $1', [batchId]);
      for (let start = 0; start < issues.length; start += CHUNK_SIZE) {
        await manager.query(
          `INSERT INTO staging_issue (batch_id, sheet_name, row_number, column_name, issue_code, raw_value, detail)
           SELECT $1, x.sheet, x."rowNumber", x."column", x.code, x."rawValue", x.detail
           FROM jsonb_to_recordset($2::jsonb)
             AS x(sheet text, "rowNumber" int, "column" text, code text, "rawValue" text, detail text)`,
          [batchId, JSON.stringify(issues.slice(start, start + CHUNK_SIZE))],
        );
      }
    });

    return { batchId, sheets: diagnosed, relations: relationsBetween(staged), otherSheets, issues };
  }

  private async sheetsOf(
    batchId: string,
    kind: StagingSourceKind,
  ): Promise<ReadonlyArray<SheetMeta>> {
    const [batch] = (await this.dataSource.query(
      'SELECT source_kind, sheets FROM staging_batch WHERE id = $1',
      [batchId],
    )) as Array<{ source_kind: string; sheets: SheetMeta[] }>;
    if (!batch) {
      throw new Error(`No existe el lote de staging ${batchId}`);
    }
    if (batch.source_kind !== kind) {
      throw new Error(`El lote ${batchId} es ${batch.source_kind}, no ${kind}`);
    }
    const result: SheetMeta[] = [];
    for (const sheet of batch.sheets) {
      const headerRow = headerRowFor(kind, sheet.name);
      const [row] = (await this.dataSource.query(
        'SELECT cells FROM staging_row WHERE batch_id = $1 AND sheet_name = $2 AND row_number = $3',
        [batchId, sheet.name, headerRow],
      )) as Array<{ cells: Record<string, RawCellValue> }>;
      result.push({
        ...sheet,
        headerRow,
        columns: Object.fromEntries(
          Object.entries(row?.cells ?? {}).map(([letter, value]) => [letter, String(value)]),
        ),
      });
    }
    return result;
  }

  private async rowsOf(batchId: string, sheet: string): Promise<StagedSheet['rows']> {
    const rows = (await this.dataSource.query(
      `SELECT row_number, cells, cell_types FROM staging_row
       WHERE batch_id = $1 AND sheet_name = $2 ORDER BY row_number`,
      [batchId, sheet],
    )) as Array<{
      row_number: number;
      cells: Record<string, RawCellValue>;
      cell_types: Record<string, string>;
    }>;
    return rows.map((row) => ({
      rowNumber: row.row_number,
      cells: row.cells,
      types: row.cell_types,
    }));
  }

  private async costCenterCodes(batchId: string): Promise<ReadonlySet<string>> {
    const sheets = await this.sheetsOf(batchId, 'COST_CENTERS');
    const meta = sheets.find((sheet) => sheet.name.trim() === COST_CENTER_SHEET);
    if (!meta) {
      throw new Error(`El lote de centros de costo no tiene la hoja '${COST_CENTER_SHEET}'`);
    }
    const letter = findColumn(meta.columns, COST_CENTER_CODE_HEADERS);
    if (!letter) {
      throw new Error(
        `No encuentro la columna de código en la hoja '${COST_CENTER_SHEET}' (encabezados: ${Object.values(meta.columns).join(', ')})`,
      );
    }
    const rows = await this.rowsOf(batchId, meta.name);
    return new Set(
      rows
        .filter((row) => row.rowNumber > meta.headerRow)
        .map((row) => String(row.cells[letter] ?? '').trim())
        .filter((code) => code !== ''),
    );
  }
}

const relationsBetween = (sheets: ReadonlyArray<StagedSheet>): ReadonlyArray<SheetRelation> => {
  const indexed = sheets.map((sheet) => {
    const idLetter = findColumn(sheet.columns, ASSET_COLUMNS.assetId);
    const byId = new Map<string, Record<string, string>>();
    for (const row of sheet.rows) {
      if (row.rowNumber <= sheet.headerRow || !idLetter) {
        continue;
      }
      const id = String(row.cells[idLetter] ?? '').trim();
      if (id === '' || byId.has(id)) {
        continue;
      }
      byId.set(
        id,
        Object.fromEntries(
          Object.entries(sheet.columns).map(([letter, header]) => [
            normalizeHeader(header),
            String(row.cells[letter] ?? '').trim(),
          ]),
        ),
      );
    }
    return { name: sheet.name, byId, headers: new Set(Object.values(sheet.columns).map(normalizeHeader)) };
  });
  const relations: SheetRelation[] = [];
  for (let i = 0; i < indexed.length; i += 1) {
    for (let j = i + 1; j < indexed.length; j += 1) {
      const left = indexed[i]!;
      const right = indexed[j]!;
      const common = [...left.headers].filter((header) => header !== '' && right.headers.has(header));
      let shared = 0;
      let identical = 0;
      for (const [id, values] of left.byId) {
        const other = right.byId.get(id);
        if (!other) {
          continue;
        }
        shared += 1;
        if (common.every((header) => values[header] === other[header])) {
          identical += 1;
        }
      }
      relations.push({
        left: left.name,
        right: right.name,
        sharedIds: shared,
        identicalRows: identical,
        commonColumns: common.length,
      });
    }
  }
  return relations;
};
