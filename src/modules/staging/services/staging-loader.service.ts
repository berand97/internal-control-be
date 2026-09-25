import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import { readWorkbook, type RawSheet } from '../excel/read-workbook.js';
import { headerRowFor, type StagingSourceKind } from '../staging-sources.js';

const CHUNK_SIZE = 1000;

export interface StagingLoadResult {
  readonly batchId: string;
  readonly created: boolean;
  readonly sheets: ReadonlyArray<{ readonly name: string; readonly rows: number }>;
}

@Injectable()
export class StagingLoaderService {
  constructor(private readonly dataSource: DataSource) {}

  async load(
    path: string,
    kind: StagingSourceKind,
    loadedBy: string | null = null,
  ): Promise<StagingLoadResult> {
    return this.loadBuffer(await readFile(path), basename(path), kind, loadedBy);
  }

  async loadBuffer(
    content: Buffer,
    fileName: string,
    kind: StagingSourceKind,
    loadedBy: string | null = null,
  ): Promise<StagingLoadResult> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const existing = await this.findBatch(kind, sha256);
    if (existing) {
      return existing;
    }

    const sheets = await readWorkbook(content);
    const size = content.length;
    const summary = sheets.map((sheet) => sheetSummary(kind, sheet));

    try {
      const batchId = await this.dataSource.transaction(async (manager) => {
        const [batch] = (await manager.query(
          `INSERT INTO staging_batch (source_kind, file_name, file_sha256, file_size, sheets, loaded_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [kind, fileName, sha256, size, JSON.stringify(summary), loadedBy],
        )) as Array<{ id: string }>;
        const id = batch?.id ?? '';
        for (const sheet of sheets) {
          for (let start = 0; start < sheet.rows.length; start += CHUNK_SIZE) {
            const chunk = sheet.rows.slice(start, start + CHUNK_SIZE).map((row) => ({
              sheet: sheet.name,
              rn: row.rowNumber,
              cells: row.cells,
              types: row.types,
            }));
            await manager.query(
              `INSERT INTO staging_row (batch_id, sheet_name, row_number, cells, cell_types)
               SELECT $1, x.sheet, x.rn, x.cells, x.types
               FROM jsonb_to_recordset($2::jsonb) AS x(sheet text, rn int, cells jsonb, types jsonb)`,
              [id, JSON.stringify(chunk)],
            );
          }
        }
        return id;
      });
      return {
        batchId,
        created: true,
        sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })),
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.findBatch(kind, sha256);
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  private async findBatch(
    kind: StagingSourceKind,
    sha256: string,
  ): Promise<StagingLoadResult | null> {
    const [batch] = (await this.dataSource.query(
      'SELECT id FROM staging_batch WHERE source_kind = $1 AND file_sha256 = $2',
      [kind, sha256],
    )) as Array<{ id: string }>;
    if (!batch) {
      return null;
    }
    const sheets = (await this.dataSource.query(
      `SELECT sheet_name AS name, count(*)::int AS rows
       FROM staging_row WHERE batch_id = $1 GROUP BY sheet_name ORDER BY sheet_name`,
      [batch.id],
    )) as Array<{ name: string; rows: number }>;
    return { batchId: batch.id, created: false, sheets };
  }
}

const sheetSummary = (kind: StagingSourceKind, sheet: RawSheet) => {
  const headerRow = headerRowFor(kind, sheet.name);
  const header = sheet.rows.find((row) => row.rowNumber === headerRow);
  return {
    name: sheet.name,
    lastRow: sheet.lastRow,
    headerRow,
    columns: Object.fromEntries(
      Object.entries(header?.cells ?? {}).map(([letter, value]) => [letter, String(value)]),
    ),
  };
};
