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
  CENTER_SHEET,
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
 * - «Instrucciones».
 * Solo unidades: los centros de costo se administran en su propia pantalla. Centro propio y Depende de aceptan códigos
 * de centro, que se validan contra los centros del sistema; una hoja «Centros de costo» de un archivo viejo se ignora.
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
    note: 'Los números que identifican este cuadro del organigrama. Una dependencia empieza por los números de su jefe y lleva más. Ej.: Vicerrectoría Financiera = 4; Servicios Administrativos (depende de ella) = 43; Logística = 4115. Puede escribir el código de Contabilidad completo: 1200 se toma como 12 y 1210 como 121 (se quitan los ceros del final). Los códigos de sus centros de costo empiezan por estos números (4350 es de la 43). Cada cuadro lleva números distintos. Vacío: una fila que ya existía conserva los suyos; para quitarlos escriba NINGUNO. Consejos y comités van vacíos.',
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
    note: 'Qué clase de cuadro es: Rectoría, Vicerrectoría, Facultad, Departamento, Programa, Área, Dirección, Oficina, Centro, Consejo o comité, u Otro. Obligatorio en filas nuevas. Solo describe; un Consejo o comité no lleva prefijo ni centro propio. Ej.: Tesorería = Departamento; Control Interno = Oficina.',
  },
  {
    header: UNIT_HEADERS.parent,
    width: 14,
    readOnly: false,
    note: 'De qué cuadro cuelga (su jefe en el organigrama). Escriba los números (prefijo) del jefe, su código de Contabilidad (1200 = 12) o el código de su centro propio (4010 = Vicerrectoría Financiera); si el jefe no tiene números, su Código interno. Ej.: Servicios Administrativos (43) depende de 4. Si lo deja vacío: una fila que ya existía conserva su jefe; una nueva se ubica sola por sus números (43 → 4; 431 → 43) y, si tiene un solo número (ej.: 5), queda bajo la Rectoría. Para que no dependa de nadie escriba RAÍZ.',
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
    note: 'El código del centro de costo que corresponde al cuadro mismo (la oficina del jefe). Debe ser un centro activo que ya exista en el sistema (los centros se administran en la pantalla Centros de costo). Ej.: Vicerrectoría Financiera → 4010; Facultad de Administración → 2510 (Decanatura). Puede no tener (Servicios Administrativos). Vacío: una fila que ya existía conserva el que tenía; una nueva cuyo Prefijo se escribió con el código de 4 dígitos de un centro toma ese centro (1510 → 1510); una nueva de un solo número toma el de ese número seguido de 010 si existe (5 → 5010). Para quitarlo escriba NINGUNO.',
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

const INSTRUCTIONS: ReadonlyArray<string> = [
  'Excel del organigrama (unidades organizacionales)',
  '',
  '1. Cambie lo que necesite y vuelva a subir el archivo. Primero verá una revisión de los cambios (todavía no cambia nada) y luego los confirma.',
  '2. Cada encabezado tiene un comentario que explica la columna: pase el mouse por encima.',
  '3. Las columnas grises las calcula el sistema y no se editan.',
  '4. Borrar una fila del Excel NO borra nada en el sistema. Para quitar algo escriba ELIMINAR o ARCHIVAR en la columna Acción.',
  '   ELIMINAR solo borra si no hay historia; si la hay, archiva.',
  '   No se puede quitar un cuadro que todavía tenga dependencias o centros de costo activos.',
  '5. Números (prefijo) de cada cuadro: 1 número para la Rectoría y las vicerrectorías (4 = Vicerrectoría Financiera);',
  '   una dependencia empieza por los de su jefe y lleva más (43 = Servicios Administrativos, bajo 4; 4115 = Logística).',
  '   Puede escribir el código de Contabilidad completo: 1200 se toma como 12 y 1210 como 121. Consejos y comités van sin números.',
  '   En «Depende de» sirven los números del jefe, su código de Contabilidad (1200) o el de su centro propio (4010 = Vicerrectoría Financiera).',
  '6. Los centros de costo no se editan en este archivo: se administran en la pantalla Centros de costo.',
  '   «Centro propio» y «Depende de» aceptan el código de un centro que ya exista en el sistema.',
  '7. Celdas vacías: una fila que ya existía conserva lo que tenía (números, de quién depende, línea, centro propio, estado).',
  '   Para que un cuadro no dependa de nadie escriba RAÍZ en «Depende de»; para quitarle los números o el centro propio, NINGUNO.',
  '8. Filas nuevas: deje vacío «Código interno». Si no llena «Depende de», el sistema lo ubica por sus números (43 → 4; 431 → 43);',
  '   con un solo número (ej.: 5) queda bajo la Rectoría. Si no llena «Centro propio», el cuadro 5 toma el centro 5010 si existe,',
  '   y un cuadro escrito con el código de un centro existente (1510) toma ese centro.',
  '   La revisión le muestra cada valor que el sistema completó.',
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
  options: { readonly example: boolean; readonly generatedAt: Date },
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Control Interno UNAC';
  workbook.created = options.generatedAt;
  workbook.modified = options.generatedAt;
  workbook.title = 'Organigrama';

  const unitSheet = workbook.addWorksheet(UNIT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
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
  // Archivos viejos traen «Centros de costo»: se ignora (el plan lo advierte); los centros tienen su propia pantalla.
  const ignoredCenterSheet = findSheet(sheets, CENTER_SHEET) !== undefined;
  return { units, centers: [], hasUnitSheet, hasCenterSheet: false, ignoredCenterSheet };
};
