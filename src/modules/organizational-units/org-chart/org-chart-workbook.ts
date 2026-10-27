import ExcelJS from 'exceljs';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { type RawSheet, readWorkbookWithProperties } from '../../staging/excel/read-workbook.js';
import {
  ORG_RELATION_TYPE_LABELS,
  ORG_RELATION_TYPES,
  ORG_UNIT_TYPE_LABELS,
  ORG_UNIT_TYPES,
  OrgRelationType,
  OrgUnitType,
} from '../enums/org-unit-type.enum.js';
import {
  type OrgChartStamp,
  readStampSheet,
  type StampValues,
  stampRow,
  STAMP_FORMAT_VERSION,
  statusText,
  writeStampSheet,
} from './org-chart-stamp.js';
import {
  ACTION_ARCHIVE,
  ACTION_DELETE,
  CENTER_SHEET,
  cellText,
  INSTRUCTIONS_SHEET,
  normalizeText,
  type OrgChartInput,
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  UNIT_HEADERS,
  UNIT_SHEET,
  UNIT_TYPE_OPTIONS,
  type UnitRowInput,
} from './org-chart.types.js';

export interface ExportUnitRow {
  readonly depth: number;
  readonly prefix: string | null;
  readonly name: string;
  readonly typeLabel: string;
  readonly parent: string | null;
  readonly relationLabel: string;
  readonly headCenter: string | null;
  readonly color: string | null;
  readonly isActive: boolean;
  readonly code: string | null;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SPARE_ROWS = 500;
const HEADER_FILL = 'FF1F4E78';
const READ_ONLY_FILL = 'FFE7E6E6';
const READ_ONLY_HEADER_FILL = 'FF808080';

interface ColumnSpec {
  readonly header: string;
  readonly width: number;
  readonly readOnly: boolean;
  readonly list?: ReadonlyArray<string>;
  readonly note: string;
}

const UNIT_COLUMNS: ReadonlyArray<ColumnSpec> = [
  {
    header: UNIT_HEADERS.prefix,
    width: 10,
    readOnly: false,
    note: 'Los números de la dependencia. Empiezan por los de su jefe y llevan más dígitos. Por ejemplo, Vicerrectoría Financiera es 4, Servicios Administrativos es 43 y Logística es 4115. Puede escribir el código contable completo. 1200 se toma como 12 y 1210 como 121. Los códigos de sus centros de costo empiezan por estos números. Cada dependencia lleva números distintos. Si lo deja vacío, una fila existente conserva los suyos. Para quitarlos escriba NINGUNO. Consejos, comités y comisiones van sin números.',
  },
  {
    header: UNIT_HEADERS.name,
    width: 52,
    readOnly: false,
    note: 'Nombre de la dependencia tal como aparece en el organigrama. Es obligatorio.',
  },
  {
    header: UNIT_HEADERS.type,
    width: 24,
    readOnly: false,
    list: ORG_UNIT_TYPES.map((type) => ORG_UNIT_TYPE_LABELS[type]),
    note: `Tipo de dependencia según la Estructura Orgánica (Acuerdo 008/2021). Opciones: ${UNIT_TYPE_OPTIONS}. Es obligatorio en filas nuevas. Use Dependencia cuando ningún otro tipo encaje. Consejo, Comité y Comisión van sin prefijo ni centro propio.`,
  },
  {
    header: UNIT_HEADERS.parent,
    width: 14,
    readOnly: false,
    note: 'El jefe de la dependencia en el organigrama. Escriba su prefijo, su código contable (1200 es 12) o el código de su centro propio (4010 es Vicerrectoría Financiera). Si el jefe no tiene prefijo, escriba su código interno. Si lo deja vacío, una fila existente conserva su jefe y una nueva se ubica por su prefijo (43 queda bajo 4). Una fila nueva de un solo número queda bajo la Rectoría. Para dejarla en el primer nivel escriba RAÍZ.',
  },
  {
    header: UNIT_HEADERS.relation,
    width: 16,
    readOnly: false,
    list: ORG_RELATION_TYPES.map((type) => ORG_RELATION_TYPE_LABELS[type]),
    note: 'La línea que la une con su jefe. Autoridad es la línea continua y la más común. Asesoría es punteada, como la de Revisoría Fiscal. Coordinación es la línea de rayas. Si lo deja vacío, una fila existente conserva la suya y una nueva queda en Autoridad.',
  },
  {
    header: UNIT_HEADERS.headCenter,
    width: 14,
    readOnly: false,
    note: 'Código del centro de costo de la oficina del jefe. Por ejemplo, Vicerrectoría Financiera tiene el 4010 y la Facultad de Administración el 2510. Puede quedar vacío. Si el centro aún no existe, queda pendiente hasta que lo creen. Si lo deja vacío, una fila existente conserva el suyo. Una fila nueva escrita con el código de un centro (1510) toma ese centro, y una de un solo número toma el que termina en 010 (5 toma 5010). Para quitarlo escriba NINGUNO.',
  },
  {
    header: UNIT_HEADERS.color,
    width: 12,
    readOnly: false,
    note: 'Color de la rama en el organigrama, en formato #RRGGBB, como #DE9927. Las dependencias de abajo toman tonos más suaves. Si lo deja vacío, conserva el que tenga. Para quitarlo escriba NINGUNO y tomará el color de su jefe.',
  },
  {
    header: UNIT_HEADERS.status,
    width: 12,
    readOnly: false,
    list: [STATUS_ACTIVE, STATUS_ARCHIVED],
    note: 'Activo si la dependencia existe hoy. Archivado si ya no existe pero se guarda su historia. Si lo deja vacío, no cambia. Una fila nueva queda Activa.',
  },
  {
    header: UNIT_HEADERS.action,
    width: 12,
    readOnly: false,
    list: [ACTION_DELETE, ACTION_ARCHIVE],
    note: 'Úsela para quitar una dependencia. ELIMINAR la borra, o la archiva si tiene historial. ARCHIVAR la desactiva. Si la deja vacía, la fila se crea o se actualiza. Borrar la fila del Excel no borra nada.',
  },
  {
    header: UNIT_HEADERS.code,
    width: 22,
    readOnly: true,
    note: 'El sistema lo usa para reconocer la fila. No lo cambie. En filas nuevas déjelo vacío.',
  },
];

const INSTRUCTIONS: ReadonlyArray<string> = [
  'Excel del organigrama',
  '',
  '1. Haga sus cambios y suba el archivo. Primero verá una revisión de los cambios y luego los confirma.',
  '2. Pase el mouse sobre cada encabezado para ver qué va en esa columna.',
  '3. Las columnas grises las llena el sistema. No las edite.',
  '4. Borrar una fila del Excel no borra nada. Para quitar una dependencia escriba ELIMINAR o ARCHIVAR en la columna Acción.',
  '   ELIMINAR la archiva si tiene historial.',
  '   No se puede quitar una dependencia que tenga dependencias o centros de costo activos.',
  '5. Prefijo. La Rectoría y las vicerrectorías llevan un número (4 es Vicerrectoría Financiera).',
  '   Las demás empiezan por el de su jefe y llevan más dígitos (43 es Servicios Administrativos, bajo 4).',
  '   Si una dependencia pasa a otro jefe conserva su prefijo. El sistema le avisa, pero no lo impide.',
  '   Puede escribir el código contable completo. 1200 se toma como 12 y 1210 como 121.',
  '   Consejos, comités y comisiones van sin prefijo.',
  '6. Depende de. Escriba el prefijo del jefe, su código contable (1200) o el de su centro propio (4010).',
  '7. Los centros de costo se editan en su propia pantalla, no en este archivo.',
  '   Centro propio acepta un centro que aún no existe. Queda pendiente hasta que lo creen.',
  '8. Celdas vacías. Una fila existente conserva lo que tenía.',
  '   Para dejar una dependencia en el primer nivel escriba RAÍZ en Depende de. Para quitar el prefijo o el centro propio escriba NINGUNO.',
  '9. Filas nuevas. Deje vacío el código interno. Si no llena Depende de, el sistema la ubica por su prefijo (43 queda bajo 4).',
  '   Con un solo número (5) queda bajo la Rectoría. Si no llena Centro propio, la 5 toma el centro 5010 si existe.',
  '   La revisión le muestra cada valor que llenó el sistema.',
  '   Si ya hay una dependencia con el mismo nombre bajo el mismo jefe, la fila nueva sin prefijo se rechaza.',
  '   Si es la misma, copie su código interno. Si es otra, póngale prefijo o un nombre distinto.',
  '10. Color. Formato #RRGGBB, como #DE9927. Las dependencias de abajo toman tonos más suaves.',
  '   Vacío conserva el que tenga. NINGUNO lo quita y la dependencia toma el color de su jefe.',
  `11. Tipo, según la Estructura Orgánica (Acuerdo 008/2021). Opciones: ${UNIT_TYPE_OPTIONS}.`,
  '   Use Dependencia cuando ningún otro tipo encaje. Consejo, Comité y Comisión van sin prefijo ni centro propio.',
  '   En archivos viejos, Consejo o comité se lee como Consejo, Área y Otro como Dependencia, y Programa como Coordinación de programa.',
];

const columnLetter = (index: number): string => String.fromCharCode(65 + index);

interface RangeValidations {
  readonly dataValidations: { add(address: string, validation: ExcelJS.DataValidation): void };
}

const fillSheet = async (
  sheet: ExcelJS.Worksheet,
  columns: ReadonlyArray<ColumnSpec>,
  rows: ReadonlyArray<{ readonly depth: number; readonly values: ReadonlyArray<string | number | null> }>,
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
        error: 'Elija un valor de la lista.',
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

export const exportValues = (unit: ExportUnitRow): StampValues => ({
  prefix: unit.prefix,
  name: unit.name,
  type: unit.typeLabel,
  parent: unit.parent,
  relation: unit.relationLabel,
  headCenter: unit.headCenter,
  status: statusText(unit.isActive),
  color: unit.color,
});

export const TEMPLATE_EXAMPLE: StampValues = {
  prefix: '4',
  name: 'Vicerrectoría Financiera',
  type: ORG_UNIT_TYPE_LABELS[OrgUnitType.Vicerectorate],
  parent: null,
  relation: ORG_RELATION_TYPE_LABELS[OrgRelationType.Authority],
  headCenter: '4010',
  status: STATUS_ACTIVE,
  color: null,
};

const EXAMPLE_LINES: ReadonlyArray<string> = [
  '',
  'Ejemplo de una fila. Cópiela en la hoja Organigrama solo si quiere crear esa dependencia.',
  `   Prefijo ${TEMPLATE_EXAMPLE.prefix ?? ''} · Nombre ${TEMPLATE_EXAMPLE.name ?? ''} · Tipo ${TEMPLATE_EXAMPLE.type ?? ''} · Depende de (vacío) · Línea ${TEMPLATE_EXAMPLE.relation ?? ''} · Centro propio ${TEMPLATE_EXAMPLE.headCenter ?? ''} · Color (vacío) · Estado ${TEMPLATE_EXAMPLE.status ?? ''} · Código interno (vacío)`,
];

export interface OrgChartWorkbookOptions {
  readonly kind: 'EXPORT' | 'TEMPLATE';
  readonly generatedAt: Date;
  readonly revision: string;
}

export const buildOrgChartWorkbook = async (
  units: ReadonlyArray<ExportUnitRow>,
  options: OrgChartWorkbookOptions,
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Control Interno UNAC';
  workbook.created = options.generatedAt;
  workbook.modified = options.generatedAt;
  workbook.title = 'Organigrama';

  const unitSheet = workbook.addWorksheet(UNIT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const instructions = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  const rows = options.kind === 'TEMPLATE' ? [] : units;

  await fillSheet(
    unitSheet,
    UNIT_COLUMNS,
    rows.map((unit) => {
      const values = exportValues(unit);
      return {
        depth: unit.depth,
        values: [
          values.prefix,
          values.name,
          values.type,
          values.parent,
          values.relation,
          values.headCenter,
          values.color,
          values.status,
          null,
          unit.code,
        ],
      };
    }),
  );
  instructions.getColumn('A').width = 120;
  [...INSTRUCTIONS, ...(options.kind === 'TEMPLATE' ? EXAMPLE_LINES : [])].forEach((line, index) => {
    const cell = instructions.getCell(`A${index + 1}`);
    cell.value = line;
    if (index === 0) {
      cell.font = { bold: true, size: 13 };
    }
  });
  const stamp: OrgChartStamp = {
    formatVersion: STAMP_FORMAT_VERSION,
    kind: options.kind,
    exportedAt: options.generatedAt.toISOString(),
    revision: options.revision,
    rows: rows.filter((unit) => unit.code).map((unit) => stampRow(unit.code ?? '', exportValues(unit))),
  };
  await writeStampSheet(workbook, stamp);

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
  let createdAt: Date | null;
  try {
    ({ sheets, createdAt } = await readWorkbookWithProperties(content));
  } catch (error) {
    if (error instanceof ApiException) {
      throw error;
    }
    throw new ApiException(ErrorCode.OrgChartInvalidFile, 'No se pudo leer el archivo. Suba un Excel (.xlsx).');
  }
  const unitSheet = findSheet(sheets, UNIT_SHEET);
  const units: UnitRowInput[] = [];
  let hasUnitSheet = false;

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
          color: read(row.cells, 'color'),
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
  if (!hasUnitSheet) {
    throw new ApiException(ErrorCode.OrgChartInvalidFile);
  }
  const ignoredCenterSheet = findSheet(sheets, CENTER_SHEET) !== undefined;
  const stamp = readStampSheet(sheets);
  return {
    units,
    centers: [],
    hasUnitSheet,
    hasCenterSheet: false,
    ignoredCenterSheet,
    stamp: stamp.status === 'OK' ? stamp.stamp : null,
    invalidStamp: stamp.status === 'INVALID',
    fileCreatedAt: createdAt?.toISOString() ?? null,
  };
};
