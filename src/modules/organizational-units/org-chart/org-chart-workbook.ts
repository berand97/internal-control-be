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
  {
    header: UNIT_HEADERS.prefix,
    width: 10,
    readOnly: false,
    note: 'Los números que identifican este cuadro del organigrama. Una dependencia lleva los números de su jefe más uno. Ej.: Vicerrectoría Financiera = 4; Servicios Administrativos (depende de ella) = 43. Los códigos de sus centros de costo empiezan por estos números (4350 es de la 43). Consejos y comités van vacíos.',
  },
  {
    header: UNIT_HEADERS.name,
    width: 52,
    readOnly: false,
    note: 'Nombre del cuadro tal como aparece en el organigrama. Obligatorio. Ej.: Departamento de Servicios Administrativos.',
  },
  {
    header: UNIT_HEADERS.type,
    width: 20,
    readOnly: false,
    list: ORG_UNIT_TYPES.map((type) => ORG_UNIT_TYPE_LABELS[type]),
    note: 'Qué clase de cuadro es: Rectoría, Vicerrectoría, Facultad, Departamento, Programa, Área, Dirección, Oficina, Centro, Consejo o comité, u Otro. Obligatorio en filas nuevas. Solo describe; un Consejo o comité no puede tener centros de costo ni activos. Ej.: Tesorería = Departamento; Control Interno = Oficina.',
  },
  {
    header: UNIT_HEADERS.parent,
    width: 14,
    readOnly: false,
    note: 'De qué cuadro cuelga (su jefe en el organigrama). Escriba los números (prefijo) del jefe; si el jefe no tiene números, su Código interno. Ej.: Servicios Administrativos (43) depende de 4. Si lo deja vacío: una fila que ya existía conserva su jefe; una nueva se ubica sola por sus números (43 → 4; 431 → 43) y, si tiene un solo número (ej.: 5), queda bajo la Rectoría. Para que no dependa de nadie escriba RAÍZ.',
  },
  {
    header: UNIT_HEADERS.relation,
    width: 16,
    readOnly: false,
    list: ORG_RELATION_TYPES.map((type) => ORG_RELATION_TYPE_LABELS[type]),
    note: 'Tipo de raya que lo une con su jefe, como en el organigrama impreso. Autoridad (línea continua): depende directamente, la mayoría. Asesoría (punteada): aconseja, no está en la cadena de mando (ej.: Revisoría Fiscal). Coordinación (rayas): coordina con otro (ej.: TAPH Bucaramanga). Vacío: una fila que ya existía conserva la suya; una nueva queda en Autoridad.',
  },
  {
    header: UNIT_HEADERS.headCenter,
    width: 14,
    readOnly: false,
    note: 'El centro de costo que corresponde al cuadro mismo (la oficina del jefe), donde quedan sus activos. Ej.: Vicerrectoría Financiera → 4010; Facultad de Administración → 2510 (Decanatura). Puede no tener (Servicios Administrativos). Vacío: una fila que ya existía conserva el que tenía; una nueva de un solo número toma el de ese número seguido de 010 si existe (5 → 5010). Para quitarlo escriba NINGUNO.',
  },
  {
    header: UNIT_HEADERS.status,
    width: 12,
    readOnly: false,
    list: [STATUS_ACTIVE, STATUS_ARCHIVED],
    note: 'Activo: el cuadro existe hoy. Archivado: ya no existe, pero se guarda su historia. Vacío: no cambia (una fila nueva queda Activa).',
  },
  {
    header: UNIT_HEADERS.action,
    width: 12,
    readOnly: false,
    list: [ACTION_DELETE, ACTION_ARCHIVE],
    note: 'Solo para quitar algo. Vacío: la fila se crea o se actualiza. ELIMINAR: se borra (si tiene historia, se archiva). ARCHIVAR: se desactiva. Borrar la fila del Excel NO borra nada en el sistema.',
  },
  {
    header: UNIT_HEADERS.code,
    width: 22,
    readOnly: true,
    note: 'Lo usa el sistema para reconocer la fila. No lo cambie. En filas nuevas déjelo vacío: se llena solo.',
  },
];

const CENTER_COLUMNS: ReadonlyArray<ColumnSpec> = [
  {
    header: CENTER_HEADERS.code,
    width: 10,
    readOnly: false,
    note: 'Código de Contabilidad, 4 números. Obligatorio. Ej.: 4350 Tesorería. Sus primeros números dicen a qué cuadro del organigrama pertenece (4350 → 43).',
  },
  {
    header: CENTER_HEADERS.name,
    width: 52,
    readOnly: false,
    note: 'Nombre del centro de costo tal como lo usa Contabilidad. Obligatorio. Ej.: TESORERÍA.',
  },
  {
    header: CENTER_HEADERS.movement,
    width: 12,
    readOnly: false,
    list: ['1', '0'],
    note: '1: se le pueden asignar activos. 0: solo agrupa a otros centros. Vacío: una fila que ya existía no cambia; una nueva queda en 1.',
  },
  {
    header: CENTER_HEADERS.unit,
    width: 40,
    readOnly: true,
    note: 'Lo calcula el sistema, no se edita. El cuadro del organigrama al que pertenece, según los primeros números del código. Ej.: 4351 → 43 Servicios Administrativos; 9228 → 9 si no hay un 92.',
  },
  {
    header: CENTER_HEADERS.parent,
    width: 10,
    readOnly: true,
    note: 'Lo calcula el sistema, no se edita. El centro del que cuelga dentro de su cuadro. Ej.: 4351 Control Presupuestal cuelga de 4350 Tesorería. Los terminados en 0 o en 5 no cuelgan de otro centro (4115 va al lado de 4110, no debajo).',
  },
  {
    header: CENTER_HEADERS.assets,
    width: 10,
    readOnly: true,
    note: 'Lo calcula el sistema, no se edita. Cuántos activos (no dados de baja) tiene hoy el centro. Ej.: 12.',
  },
  {
    header: CENTER_HEADERS.status,
    width: 12,
    readOnly: false,
    list: [STATUS_ACTIVE, STATUS_ARCHIVED],
    note: 'Activo: el centro se usa hoy. Archivado: ya no se usa, pero se guarda su historia. Vacío: no cambia (una fila nueva queda Activa).',
  },
  {
    header: CENTER_HEADERS.action,
    width: 12,
    readOnly: false,
    list: [ACTION_DELETE, ACTION_ARCHIVE],
    note: 'Solo para quitar algo. Vacío: la fila se crea o se actualiza. ELIMINAR: se borra (si tiene historia, se archiva). ARCHIVAR: se desactiva. Un centro con activos no se puede quitar. Borrar la fila del Excel NO borra nada en el sistema.',
  },
  {
    header: CENTER_HEADERS.previousCode,
    width: 16,
    readOnly: false,
    note: 'Solo para cambiar el código de un centro: escriba aquí el código actual y en Código el nuevo; conserva sus activos e historia. Ej.: Código anterior 4352, Código 4355. En las demás filas déjelo vacío.',
  },
];

const INSTRUCTIONS: ReadonlyArray<string> = [
  'Excel del organigrama y de los centros de costo',
  '',
  '1. Cambie lo que necesite y vuelva a subir el archivo. Primero verá una revisión de los cambios (todavía no cambia nada) y luego los confirma.',
  '2. Cada encabezado tiene un comentario que explica la columna: pase el mouse por encima.',
  '3. Las columnas grises las calcula el sistema y no se editan.',
  '4. Borrar una fila del Excel NO borra nada en el sistema. Para quitar algo escriba ELIMINAR o ARCHIVAR en la columna Acción.',
  '   ELIMINAR solo borra si no hay historia (activos, movimientos, actas, documentos); si la hay, archiva.',
  '   No se puede quitar un centro con activos ni un cuadro que todavía tenga dependencias o centros activos.',
  '5. Números (prefijo) de cada cuadro: 1 número para la Rectoría y las vicerrectorías (4 = Vicerrectoría Financiera);',
  '   una dependencia lleva los de su jefe más uno (43 = Servicios Administrativos, bajo 4). Consejos y comités van sin números.',
  '6. Cada centro de costo pertenece al cuadro cuyos números coinciden con el inicio de su código (2523 → 25; 9228 → 9 si no hay 92).',
  '   Dentro del cuadro, 4351 cuelga de 4350; los terminados en 0 o en 5 no cuelgan de otro centro (4115 va al lado de 4110).',
  '7. Celdas vacías: una fila que ya existía conserva lo que tenía (de quién depende, línea, centro propio, estado).',
  '   Para que un cuadro no dependa de nadie escriba RAÍZ en «Depende de»; para quitarle el centro propio, NINGUNO.',
  '8. Filas nuevas: deje vacío «Código interno». Si no llena «Depende de», el sistema lo ubica por sus números (43 → 4; 431 → 43);',
  '   con un solo número (ej.: 5) queda bajo la Rectoría. Si no llena «Centro propio», el cuadro 5 toma el centro 5010 si existe.',
  '   La revisión le muestra cada valor que el sistema completó.',
  '9. Para cambiar el código de un centro escriba el código actual en «Código anterior» y el nuevo en «Código» (ej.: 4352 → 4355).',
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
