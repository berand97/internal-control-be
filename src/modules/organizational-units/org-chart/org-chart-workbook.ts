import ExcelJS from 'exceljs';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { type RawSheet, readWorkbook } from '../../staging/excel/read-workbook.js';
import {
  ORG_RELATION_TYPE_LABELS,
  ORG_RELATION_TYPES,
  ORG_UNIT_TYPE_LABELS,
  ORG_UNIT_TYPES,
} from '../enums/org-unit-type.enum.js';
import {
  ACTION_ARCHIVE,
  ACTION_DELETE,
  CENTER_HEADERS,
  CENTER_SHEET,
  type CenterRowInput,
  cellText,
  INSTRUCTIONS_SHEET,
  normalizeText,
  type OrgChartInput,
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  UNIT_HEADERS,
  UNIT_SHEET,
  type UnitRowInput,
} from './org-chart.types.js';

/**
 * Libro Excel del organigrama (exportación y plantilla) y su lectura (importación).
 *
 * - «Organigrama»: una fila por unidad, en orden de árbol (prefijo y nombre), con sangría por nivel en Nombre.
 * - «Centros de costo»: una fila por centro, por código; Unidad, Padre y Activos son de solo lectura (derivados).
 * - «Instrucciones».
 * Encabezados y columnas de solo lectura en gris y protegidos (protección sin contraseña: Revisar → Desproteger hoja);
 * las columnas editables quedan desbloqueadas y con listas desplegables donde aplica.
 */

export interface ExportUnitRow {
  readonly depth: number;
  readonly prefix: string | null;
  readonly name: string;
  readonly typeLabel: string;
  readonly parent: string | null;
  readonly relationLabel: string;
  readonly headCenter: string | null;
  readonly isActive: boolean;
  readonly code: string | null;
}

export interface ExportCenterRow {
  readonly depth: number;
  readonly code: string;
  readonly name: string;
  readonly hasMovement: boolean;
  readonly unit: string | null;
  readonly parent: string | null;
  readonly assets: number | null;
  readonly isActive: boolean;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Filas editables (desbloqueadas y con lista) por debajo de las que trae el archivo. */
const SPARE_ROWS = 500;
const HEADER_FILL = 'FF1F4E78';
const READ_ONLY_FILL = 'FFE7E6E6';
const READ_ONLY_HEADER_FILL = 'FF808080';
const EXAMPLE_FILL = 'FFFFF2CC';

interface ColumnSpec {
  readonly header: string;
  readonly width: number;
  readonly readOnly: boolean;
  readonly list?: ReadonlyArray<string>;
  readonly note: string;
}

const UNIT_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { header: UNIT_HEADERS.prefix, width: 10, readOnly: false, note: 'Dígitos con que empiezan los códigos de sus centros (4, 43…). El de una hija es el de su padre más un dígito. Vacío: sin prefijo (consejos, cuadros sin centros).' },
  { header: UNIT_HEADERS.name, width: 52, readOnly: false, note: 'Nombre del cuadro del organigrama. Obligatorio.' },
  { header: UNIT_HEADERS.type, width: 20, readOnly: false, list: ORG_UNIT_TYPES.map((type) => ORG_UNIT_TYPE_LABELS[type]), note: 'Tipo de cuadro (lista). Obligatorio en las nuevas.' },
  { header: UNIT_HEADERS.parent, width: 14, readOnly: false, note: 'Prefijo de la unidad de la que depende; si esa unidad no tiene prefijo, su código interno. RAÍZ: queda en la raíz. Vacío: una existente conserva su padre; una nueva lo deduce del prefijo (43 → 4; 431 → 43) o, con prefijo de un dígito, cuelga de la Rectoría; si no, raíz.' },
  { header: UNIT_HEADERS.relation, width: 16, readOnly: false, list: ORG_RELATION_TYPES.map((type) => ORG_RELATION_TYPE_LABELS[type]), note: 'Línea del organigrama hacia la unidad de la que depende. Vacío: una existente conserva la suya; una nueva, Autoridad.' },
  { header: UNIT_HEADERS.headCenter, width: 14, readOnly: false, note: 'Código del centro de costo propio del cuadro (p. ej. 2510 para la Facultad 25). NINGUNO: se le quita. Vacío: una existente conserva el suyo; una nueva de prefijo X toma X010 si existe.' },
  { header: UNIT_HEADERS.status, width: 12, readOnly: false, list: [STATUS_ACTIVE, STATUS_ARCHIVED], note: 'Activo o Archivado. Vacío: una existente conserva su estado; una nueva, Activo.' },
  { header: UNIT_HEADERS.action, width: 12, readOnly: false, list: [ACTION_DELETE, ACTION_ARCHIVE], note: 'Vacío: se crea o actualiza. ELIMINAR: se borra (o se archiva si tiene historia). ARCHIVAR: se desactiva.' },
  { header: UNIT_HEADERS.code, width: 22, readOnly: true, note: 'Identifica la unidad (no lo cambie). En una fila nueva déjelo vacío: se genera.' },
];

const CENTER_COLUMNS: ReadonlyArray<ColumnSpec> = [
  { header: CENTER_HEADERS.code, width: 10, readOnly: false, note: 'Código de Contabilidad (cuatro dígitos). Obligatorio.' },
  { header: CENTER_HEADERS.name, width: 52, readOnly: false, note: 'Nombre del centro de costo. Obligatorio.' },
  { header: CENTER_HEADERS.movement, width: 12, readOnly: false, list: ['1', '0'], note: '1: recibe movimientos; 0: agrupador.' },
  { header: CENTER_HEADERS.unit, width: 40, readOnly: true, note: 'Solo lectura: la unidad con el prefijo más largo con que empieza el código.' },
  { header: CENTER_HEADERS.parent, width: 10, readOnly: true, note: 'Solo lectura: XYZn cuelga de XYZ0 (si existe); XYZ0 y XYZ5 cuelgan de su unidad.' },
  { header: CENTER_HEADERS.assets, width: 10, readOnly: true, note: 'Solo lectura: activos no dados de baja en el centro.' },
  { header: CENTER_HEADERS.status, width: 12, readOnly: false, list: [STATUS_ACTIVE, STATUS_ARCHIVED], note: 'Activo o Archivado.' },
  { header: CENTER_HEADERS.action, width: 12, readOnly: false, list: [ACTION_DELETE, ACTION_ARCHIVE], note: 'Vacío: se crea o actualiza. ELIMINAR: se borra (o se archiva si tiene historia). ARCHIVAR: se desactiva.' },
  { header: CENTER_HEADERS.previousCode, width: 16, readOnly: false, note: 'Para cambiar el código de un centro existente: escriba aquí el código actual y en Código el nuevo. Conserva activos e historia.' },
];

const INSTRUCTIONS: ReadonlyArray<string> = [
  'Excel del organigrama institucional y de los centros de costo.',
  '',
  '1. Modifique las filas y vuelva a subir el archivo: primero se previsualiza (nada cambia) y luego se confirma.',
  '2. Las filas que borre del archivo NO se borran del sistema. Para eliminar o archivar use la columna Acción.',
  '3. ELIMINAR borra de verdad solo si no hay historia (activos, movimientos, actas, documentos…); si la hay, archiva.',
  '   Un centro con activos o una unidad con hijas o centros activos no se puede eliminar ni archivar.',
  '4. Prefijos: 1 dígito = rectoría o vicerrectoría; 2 dígitos = un cuadro del organigrama. El de una unidad hija',
  '   es el de su padre más un dígito (4 → 43). Consejos y comités van sin prefijo.',
  '5. Cada centro queda en la unidad con el prefijo más largo con que empieza su código (2523 → 25; 9228 → 9).',
  '6. Padre de un centro: XYZn cuelga de XYZ0 si existe (4351 → 4350); XYZ0 y XYZ5 cuelgan de su unidad',
  '   (4115 es hermano de 4110). Si falta el XYZ0 el centro queda en su unidad y se avisa como código que no cuadra.',
  '7. Para cambiar el código de un centro escriba el código actual en «Código anterior» y el nuevo en «Código».',
  '8. Las columnas grises son de solo lectura (las hojas están protegidas sin contraseña).',
  '9. Unidades nuevas: deje vacío «Código interno»; se genera solo.',
  '10. Celdas vacías en el Organigrama: una unidad existente conserva lo que tiene (Depende de, Línea, Centro propio,',
  '   Estado). Para volverla raíz escriba RAÍZ en «Depende de»; para quitarle el centro propio, NINGUNO.',
  '11. Una unidad nueva sin «Depende de» lo deduce del prefijo (43 → 4; 431 → 43, si no 4); con prefijo de un dígito',
  '   cuelga de la Rectoría (si hay una sola); sin prefijo queda en la raíz. Sin «Centro propio», la de prefijo X toma',
  '   X010 si existe. Sin «Línea», Autoridad. La previsualización avisa de cada valor deducido.',
];

const columnLetter = (index: number): string => String.fromCharCode(65 + index);

/** exceljs 4.4 acepta rangos en dataValidations.add, pero sus tipos no declaran la propiedad. */
interface RangeValidations {
  readonly dataValidations: { add(address: string, validation: ExcelJS.DataValidation): void };
}

const fillSheet = async (
  sheet: ExcelJS.Worksheet,
  columns: ReadonlyArray<ColumnSpec>,
  rows: ReadonlyArray<{ readonly depth: number; readonly values: ReadonlyArray<string | number | null> }>,
  example: boolean,
): Promise<void> => {
  columns.forEach((spec, index) => {
    const letter = columnLetter(index);
    const column = sheet.getColumn(letter);
    column.width = spec.width;
    const header = sheet.getCell(`${letter}1`);
    header.value = spec.header;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: spec.readOnly ? READ_ONLY_HEADER_FILL : HEADER_FILL } };
    header.note = spec.note;
  });
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    columns.forEach((spec, index) => {
      const cell = sheet.getCell(`${columnLetter(index)}${rowNumber}`);
      const value = row.values[index] ?? null;
      cell.value = typeof value === 'number' ? value : value === null ? null : value;
      if (typeof value === 'string') {
        cell.numFmt = '@';
      }
      if (index === 1 && row.depth > 0) {
        cell.alignment = { indent: Math.min(row.depth, 15) };
      }
      if (spec.readOnly) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: READ_ONLY_FILL } };
      } else if (example) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXAMPLE_FILL } };
      }
    });
  });
  const lastEditable = rows.length + 1 + SPARE_ROWS;
  columns.forEach((spec, index) => {
    const letter = columnLetter(index);
    if (!spec.readOnly) {
      for (let rowNumber = 2; rowNumber <= lastEditable; rowNumber += 1) {
        const cell = sheet.getCell(`${letter}${rowNumber}`);
        cell.protection = { locked: false };
        if (rowNumber > rows.length + 1) {
          cell.numFmt = '@';
        }
      }
    }
    if (spec.list) {
      (sheet as unknown as RangeValidations).dataValidations.add(`${letter}2:${letter}${lastEditable}`, {
        type: 'list',
        allowBlank: true,
        formulae: [`"${spec.list.join(',')}"`],
        showErrorMessage: true,
        errorTitle: spec.header,
        error: `Elija un valor de la lista: ${spec.list.join(', ')}`,
      });
    }
  });
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(columns.length - 1)}1` };
  await sheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: true,
    formatRows: true,
    autoFilter: true,
    sort: true,
    insertRows: true,
  });
};

export const buildOrgChartWorkbook = async (
  units: ReadonlyArray<ExportUnitRow>,
  centers: ReadonlyArray<ExportCenterRow>,
  options: { readonly example: boolean; readonly generatedAt: Date },
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Control Interno UNAC';
  workbook.created = options.generatedAt;
  workbook.modified = options.generatedAt;
  workbook.title = 'Organigrama y centros de costo';

  const unitSheet = workbook.addWorksheet(UNIT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const centerSheet = workbook.addWorksheet(CENTER_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const instructions = workbook.addWorksheet(INSTRUCTIONS_SHEET);

  await fillSheet(
    unitSheet,
    UNIT_COLUMNS,
    units.map((unit) => ({
      depth: unit.depth,
      values: [
        unit.prefix,
        unit.name,
        unit.typeLabel,
        unit.parent,
        unit.relationLabel,
        unit.headCenter,
        unit.isActive ? STATUS_ACTIVE : STATUS_ARCHIVED,
        null,
        unit.code,
      ],
    })),
    options.example,
  );
  await fillSheet(
    centerSheet,
    CENTER_COLUMNS,
    centers.map((center) => ({
      depth: center.depth,
      values: [
        center.code,
        center.name,
        center.hasMovement ? 1 : 0,
        center.unit,
        center.parent,
        center.assets,
        center.isActive ? STATUS_ACTIVE : STATUS_ARCHIVED,
        null,
        null,
      ],
    })),
    options.example,
  );

  instructions.getColumn('A').width = 120;
  INSTRUCTIONS.forEach((line, index) => {
    const cell = instructions.getCell(`A${index + 1}`);
    cell.value = line;
    if (index === 0) {
      cell.font = { bold: true, size: 13 };
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const headerMap = (sheet: RawSheet): Map<string, string> => {
  const header = sheet.rows.find((row) => row.rowNumber === 1);
  const map = new Map<string, string>();
  for (const [letter, value] of Object.entries(header?.cells ?? {})) {
    const text = cellText(value);
    if (text) {
      map.set(normalizeText(text), letter);
    }
  }
  return map;
};

const findSheet = (sheets: ReadonlyArray<RawSheet>, name: string): RawSheet | undefined =>
  sheets.find((sheet) => normalizeText(sheet.name) === normalizeText(name));

/** Texto de una celda: los nombres conservan sus espacios internos; el resto se compacta. */
const reader = (sheet: RawSheet, headers: Record<string, string>) => {
  const map = headerMap(sheet);
  const letters = Object.fromEntries(
    Object.entries(headers).map(([field, header]) => [field, map.get(normalizeText(header))]),
  ) as Record<string, string | undefined>;
  return {
    letters,
    read: (cells: Record<string, string | number | boolean>, field: string): string | null => {
      const letter = letters[field];
      if (!letter) {
        return null;
      }
      const value = cells[letter];
      if (value === undefined || value === null) {
        return null;
      }
      if (field === 'name') {
        const text = String(value).trim();
        return text === '' ? null : text;
      }
      return cellText(value);
    },
  };
};

export const parseOrgChartWorkbook = async (content: Buffer): Promise<OrgChartInput> => {
  let sheets: ReadonlyArray<RawSheet>;
  try {
    sheets = await readWorkbook(content);
  } catch (error) {
    if (error instanceof ApiException) {
      throw error;
    }
    throw new ApiException(ErrorCode.OrgChartInvalidFile, 'No se pudo leer el archivo: debe ser un Excel (.xlsx)');
  }
  const unitSheet = findSheet(sheets, UNIT_SHEET);
  const centerSheet = findSheet(sheets, CENTER_SHEET);
  const units: UnitRowInput[] = [];
  const centers: CenterRowInput[] = [];
  let hasUnitSheet = false;
  let hasCenterSheet = false;

  if (unitSheet) {
    const { letters, read } = reader(unitSheet, UNIT_HEADERS);
    if (letters['name']) {
      hasUnitSheet = true;
      for (const row of unitSheet.rows) {
        if (row.rowNumber === 1) {
          continue;
        }
        const unitRow: UnitRowInput = {
          rowNumber: row.rowNumber,
          prefix: read(row.cells, 'prefix'),
          name: read(row.cells, 'name'),
          type: read(row.cells, 'type'),
          parent: read(row.cells, 'parent'),
          relation: read(row.cells, 'relation'),
          headCenter: read(row.cells, 'headCenter'),
          status: read(row.cells, 'status'),
          action: read(row.cells, 'action'),
          code: read(row.cells, 'code'),
        };
        if (Object.entries(unitRow).some(([field, value]) => field !== 'rowNumber' && value !== null)) {
          units.push(unitRow);
        }
      }
    }
  }
  if (centerSheet) {
    const { letters, read } = reader(centerSheet, CENTER_HEADERS);
    if (letters['code'] && letters['name']) {
      hasCenterSheet = true;
      for (const row of centerSheet.rows) {
        if (row.rowNumber === 1) {
          continue;
        }
        const centerRow: CenterRowInput = {
          rowNumber: row.rowNumber,
          code: read(row.cells, 'code'),
          name: read(row.cells, 'name'),
          movement: read(row.cells, 'movement'),
          status: read(row.cells, 'status'),
          action: read(row.cells, 'action'),
          previousCode: read(row.cells, 'previousCode'),
        };
        if (Object.entries(centerRow).some(([field, value]) => field !== 'rowNumber' && value !== null)) {
          centers.push(centerRow);
        }
      }
    }
  }
  if (!hasUnitSheet && !hasCenterSheet) {
    throw new ApiException(ErrorCode.OrgChartInvalidFile);
  }
  return { units, centers, hasUnitSheet, hasCenterSheet };
};
