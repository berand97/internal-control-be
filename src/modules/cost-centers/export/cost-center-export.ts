import ExcelJS from 'exceljs';
import type { CostCenterTreeNodeDto } from '../dto/responses/cost-center-structure.responses.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const COST_CENTER_EXPORT_SHEET = 'Centros de costo';

export const COST_CENTER_EXPORT_HEADERS = [
  'Código',
  'Nombre',
  'Tipo',
  'Centro padre',
  'Dependencia',
  'Jefe(s) vigente(s)',
  'Activos (directos)',
  'Estado',
] as const;

const COLUMN_WIDTHS = [12, 48, 16, 48, 44, 44, 18, 12];
const HEADER_FILL = 'FF1F4E78';

export interface CostCenterExportRow {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly parent: string;
  readonly unit: string;
  readonly heads: string;
  readonly directAssets: number;
  readonly status: string;
}

const unitLabel = (node: CostCenterTreeNodeDto): string => {
  const unit = node.organizationalUnit;
  if (!unit) {
    return '';
  }
  return unit.codePrefix ? `${unit.codePrefix} · ${unit.name}` : unit.name;
};

export const costCenterExportRows = (roots: ReadonlyArray<CostCenterTreeNodeDto>): CostCenterExportRow[] => {
  const rows: CostCenterExportRow[] = [];
  const walk = (nodes: ReadonlyArray<CostCenterTreeNodeDto>, parent: CostCenterTreeNodeDto | null): void => {
    for (const node of nodes) {
      rows.push({
        code: node.externalCode,
        name: node.name,
        type: node.hasMovement ? 'Con movimiento' : 'Agrupador',
        parent: parent ? `${parent.externalCode} · ${parent.name}` : '',
        unit: unitLabel(node),
        heads: node.heads.map((head) => head.personName).join('; '),
        directAssets: node.directAssets,
        status: node.isActive ? 'Activo' : 'Archivado',
      });
      walk(node.children, node);
    }
  };
  walk(roots, null);
  return rows;
};

export const buildCostCenterExportWorkbook = async (rows: ReadonlyArray<CostCenterExportRow>): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(COST_CENTER_EXPORT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COST_CENTER_EXPORT_HEADERS.map((header, index) => ({ header, width: COLUMN_WIDTHS[index] ?? 16 }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  for (const row of rows) {
    sheet.addRow([row.code, row.name, row.type, row.parent, row.unit, row.heads, row.directAssets, row.status]);
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COST_CENTER_EXPORT_HEADERS.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const bogotaDate = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
