import type { RawCellValue } from '../excel/read-workbook.js';

export interface StagedRow {
  readonly rowNumber: number;
  readonly cells: Record<string, RawCellValue>;
  readonly types: Record<string, string>;
}

export interface StagedSheet {
  readonly name: string;
  readonly headerRow: number;
  readonly columns: Record<string, string>;
  readonly rows: ReadonlyArray<StagedRow>;
}

export interface Metric {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly base: number | null;
  readonly detail?: string;
}

export interface Issue {
  readonly sheet: string;
  readonly rowNumber: number | null;
  readonly column: string | null;
  readonly code: string;
  readonly rawValue: string | null;
  readonly detail: string | null;
}

export const ASSET_COLUMNS = {
  assetId: ['MovIdActivo'],
  barcode: ['MovCodBarras'],
  serial: ['MovNumSerie'],
  model: ['MovModelo'],
  purchaseDate: ['MovFechaCompra'],
  price: ['MovPrecioCompra'],
  costCenter: ['MovIdCentro'],
  writeOffFlag: ['MovDebaja'],
  writeOffDate: ['MovFechaDebaja'],
} as const;

export type AssetColumn = keyof typeof ASSET_COLUMNS;

const OPTIONAL_COLUMNS: ReadonlySet<AssetColumn> = new Set(['writeOffFlag', 'writeOffDate']);

export const normalizeHeader = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export const findColumn = (
  columns: Record<string, string>,
  candidates: ReadonlyArray<string>,
): string | null => {
  const wanted = new Set(candidates.map(normalizeHeader));
  const match = Object.entries(columns).find(([, header]) => wanted.has(normalizeHeader(header)));
  return match?.[0] ?? null;
};

const text = (value: RawCellValue | undefined): string =>
  value === undefined ? '' : String(value).trim();

const isBlank = (value: RawCellValue | undefined): boolean => text(value) === '';

const isDateType = (type: string | undefined): boolean =>
  type === 'date' || type === 'formula:date';

const asNumber = (value: RawCellValue | undefined): number | null => {
  if (typeof value === 'number') {
    return value;
  }
  const raw = text(value).replace(/[$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  return raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
};

const percent = (value: number, base: number): string =>
  base === 0 ? '—' : `${((value / base) * 100).toFixed(1)}%`;

export const diagnoseAssetSheet = (
  sheet: StagedSheet,
  costCenterCodes: ReadonlySet<string> | null,
  mapping?: Partial<Record<AssetColumn, string>>,
): { readonly metrics: ReadonlyArray<Metric>; readonly issues: ReadonlyArray<Issue> } => {
  const issues: Issue[] = [];
  const issue = (
    rowNumber: number | null,
    column: string | null,
    code: string,
    rawValue: RawCellValue | undefined | null,
    detail: string | null = null,
  ) =>
    issues.push({
      sheet: sheet.name,
      rowNumber,
      column,
      code,
      rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue),
      detail,
    });

  const letters = {} as Record<AssetColumn, string | null>;
  for (const key of Object.keys(ASSET_COLUMNS) as AssetColumn[]) {
    letters[key] = mapping ? (mapping[key] ?? null) : findColumn(sheet.columns, ASSET_COLUMNS[key]);
    if (!mapping && !letters[key] && !OPTIONAL_COLUMNS.has(key)) {
      issue(null, ASSET_COLUMNS[key][0], 'MISSING_COLUMN', null, 'La columna no aparece en el encabezado');
    }
  }
  const header = (key: AssetColumn): string => {
    const letter = letters[key];
    return letter ? (sheet.columns[letter] ?? letter) : ASSET_COLUMNS[key][0];
  };
  const cell = (row: StagedRow, key: AssetColumn): RawCellValue | undefined => {
    const letter = letters[key];
    return letter ? row.cells[letter] : undefined;
  };
  const type = (row: StagedRow, key: AssetColumn): string | undefined => {
    const letter = letters[key];
    return letter ? row.types[letter] : undefined;
  };

  const dataRows = sheet.rows.filter((row) => row.rowNumber > sheet.headerRow);
  const withContent = dataRows.filter((row) =>
    Object.values(row.cells).some((value) => !isBlank(value)),
  );
  const lastDataRow = withContent.at(-1)?.rowNumber ?? sheet.headerRow;
  const emptyRows = dataRows.filter(
    (row) =>
      row.rowNumber < lastDataRow &&
      !Object.values(row.cells).some((value) => !isBlank(value)),
  );
  const trailingEmpty = dataRows.filter((row) => row.rowNumber > lastDataRow).length;
  for (const row of emptyRows) {
    issue(row.rowNumber, null, 'EMPTY_ROW', null, 'Fila completamente vacía en medio de los datos');
  }
  const withoutIdentity = letters.assetId
    ? withContent.filter((row) => isBlank(cell(row, 'assetId')))
    : [];
  for (const row of withoutIdentity) {
    issue(
      row.rowNumber,
      header('assetId'),
      'ROW_WITHOUT_ASSET_ID',
      null,
      `Fila con datos pero sin ${header('assetId')}; no se cuenta como activo (columnas: ${Object.keys(row.cells).join(', ')})`,
    );
  }
  const nonEmpty = letters.assetId
    ? withContent.filter((row) => !isBlank(cell(row, 'assetId')))
    : withContent;
  const total = nonEmpty.length;

  const byAssetId = new Map<string, number[]>();
  if (letters.assetId) {
    for (const row of nonEmpty) {
      const id = text(cell(row, 'assetId'));
      byAssetId.set(id, [...(byAssetId.get(id) ?? []), row.rowNumber]);
    }
  }
  const repeatedIds = [...byAssetId.entries()].filter(([, rows]) => rows.length > 1);
  for (const [id, rows] of repeatedIds) {
    for (const rowNumber of rows) {
      issue(
        rowNumber,
        header('assetId'),
        'ASSET_ID_DUPLICATED',
        id,
        `El mismo ${header('assetId')} aparece en las filas ${rows.join(', ')}`,
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const isWrittenOff = (row: StagedRow): boolean =>
    ['TRUE', 'SI', 'SÍ', '1', 'S'].includes(text(cell(row, 'writeOffFlag')).toUpperCase());
  const writtenOff = letters.writeOffFlag ? nonEmpty.filter(isWrittenOff) : [];
  const writeOffDates: string[] = [];
  let writeOffMissing = 0;
  let writeOffNotADate = 0;
  let writeOffBeforePurchase = 0;
  let writeOffFuture = 0;
  for (const row of writtenOff) {
    const value = cell(row, 'writeOffDate');
    if (!letters.writeOffDate || isBlank(value)) {
      writeOffMissing += 1;
      issue(row.rowNumber, header('writeOffDate'), 'WRITE_OFF_DATE_MISSING', null);
      continue;
    }
    if (!isDateType(type(row, 'writeOffDate'))) {
      writeOffNotADate += 1;
      issue(row.rowNumber, header('writeOffDate'), 'WRITE_OFF_DATE_NOT_A_DATE', value);
      continue;
    }
    const date = String(value).slice(0, 10);
    writeOffDates.push(date);
    const purchase = cell(row, 'purchaseDate');
    if (isDateType(type(row, 'purchaseDate')) && date < String(purchase).slice(0, 10)) {
      writeOffBeforePurchase += 1;
      issue(row.rowNumber, header('writeOffDate'), 'WRITE_OFF_BEFORE_PURCHASE', value, `Compra: ${String(purchase).slice(0, 10)}`);
    }
    if (date > today) {
      writeOffFuture += 1;
      issue(row.rowNumber, header('writeOffDate'), 'WRITE_OFF_DATE_FUTURE', value);
    }
  }
  writeOffDates.sort();

  let temp = 0;
  let blankBarcode = 0;
  const byCode = new Map<string, number[]>();
  let missingDate = 0;
  let nonDate = 0;
  const nonDateTypes = new Map<string, number>();
  let epochDate = 0;
  let zeroPrice = 0;
  let missingPrice = 0;
  let nonNumericPrice = 0;
  let serialEmpty = 0;
  let modelEmpty = 0;
  const unknownCenters = new Map<string, number>();

  for (const row of nonEmpty) {
    if (letters.barcode) {
      const code = text(cell(row, 'barcode'));
      if (code === '') {
        blankBarcode += 1;
        issue(row.rowNumber, header('barcode'), 'BARCODE_EMPTY', null);
      } else if (code.toUpperCase() === 'TEMP') {
        temp += 1;
        issue(row.rowNumber, header('barcode'), 'BARCODE_TEMP', code);
      } else {
        byCode.set(code, [...(byCode.get(code) ?? []), row.rowNumber]);
      }
    }

    if (letters.purchaseDate) {
      const value = cell(row, 'purchaseDate');
      if (isBlank(value)) {
        missingDate += 1;
        issue(row.rowNumber, header('purchaseDate'), 'PURCHASE_DATE_MISSING', null);
      } else if (!isDateType(type(row, 'purchaseDate'))) {
        nonDate += 1;
        const kind = type(row, 'purchaseDate') ?? 'desconocido';
        nonDateTypes.set(kind, (nonDateTypes.get(kind) ?? 0) + 1);
        issue(row.rowNumber, header('purchaseDate'), 'PURCHASE_DATE_NOT_A_DATE', value, `Tipo de celda: ${kind}`);
      } else if (String(value).startsWith('1970-01-01')) {
        epochDate += 1;
        issue(row.rowNumber, header('purchaseDate'), 'PURCHASE_DATE_EPOCH', value, 'Fecha 1970-01-01');
      }
    }

    if (letters.price) {
      const value = cell(row, 'price');
      const amount = asNumber(value);
      if (isBlank(value)) {
        missingPrice += 1;
        issue(row.rowNumber, header('price'), 'PRICE_MISSING', null);
      } else if (amount === null) {
        nonNumericPrice += 1;
        issue(row.rowNumber, header('price'), 'PRICE_NOT_A_NUMBER', value);
      } else if (amount === 0) {
        zeroPrice += 1;
        issue(row.rowNumber, header('price'), 'PRICE_ZERO', value);
      }
    }

    if (letters.serial && isBlank(cell(row, 'serial'))) {
      serialEmpty += 1;
    }
    if (letters.model && isBlank(cell(row, 'model'))) {
      modelEmpty += 1;
    }

    if (letters.costCenter && costCenterCodes) {
      const code = text(cell(row, 'costCenter'));
      if (code !== '' && !costCenterCodes.has(code)) {
        unknownCenters.set(code, (unknownCenters.get(code) ?? 0) + 1);
        issue(row.rowNumber, header('costCenter'), 'COST_CENTER_UNKNOWN', code, 'No existe en el catálogo de centros de costo');
      }
    }
  }

  const duplicated = [...byCode.entries()].filter(([, rows]) => rows.length > 1);
  for (const [code, rows] of duplicated) {
    for (const rowNumber of rows) {
      issue(
        rowNumber,
        header('barcode'),
        'BARCODE_DUPLICATED',
        code,
        `Repetido en ${rows.length} filas: ${rows.join(', ')}`,
      );
    }
  }
  const duplicatedRows = duplicated.reduce((sum, [, rows]) => sum + rows.length, 0);

  const has = (key: AssetColumn, value: number) => (letters[key] ? value : null);
  const metrics: Metric[] = [
    {
      key: 'rows_read',
      label: 'Filas leídas después del encabezado',
      value: dataRows.length,
      base: null,
    },
    {
      key: 'rows',
      label: 'Activos (filas con identidad)',
      value: total,
      base: null,
      detail: letters.assetId
        ? `Filas con ${header('assetId')}; todas las métricas siguientes se calculan sobre estas`
        : `Sin columna ${header('assetId')}: se toman todas las filas con datos`,
    },
    {
      key: 'rows_without_asset_id',
      label: 'Filas con datos pero sin identidad',
      value: letters.assetId ? withoutIdentity.length : null,
      base: null,
    },
    {
      key: 'asset_id_duplicated_ids',
      label: `${header('assetId')} repetidos dentro de la hoja`,
      value: letters.assetId ? repeatedIds.length : null,
      base: null,
      detail: `${repeatedIds.reduce((sum, [, rows]) => sum + rows.length, 0)} filas involucradas`,
    },
    {
      key: 'barcode_temp',
      label: 'Código de barras TEMP',
      value: has('barcode', temp),
      base: total,
      detail: percent(temp, total),
    },
    {
      key: 'barcode_empty',
      label: 'Código de barras vacío',
      value: has('barcode', blankBarcode),
      base: total,
    },
    {
      key: 'barcode_duplicated_codes',
      label: 'Códigos reales duplicados',
      value: has('barcode', duplicated.length),
      base: null,
      detail: `${duplicatedRows} filas; máximo ${Math.max(0, ...duplicated.map(([, rows]) => rows.length))} repeticiones`,
    },
    { key: 'barcode_duplicated_rows', label: 'Filas con código duplicado', value: has('barcode', duplicatedRows), base: total },
    {
      key: 'empty_rows',
      label: 'Filas completamente vacías entre los datos',
      value: emptyRows.length,
      base: null,
      detail: `${trailingEmpty} filas vacías adicionales después de la última fila con datos`,
    },
    {
      key: 'purchase_date_missing',
      label: 'Sin fecha de compra',
      value: has('purchaseDate', missingDate),
      base: total,
      detail: percent(missingDate, total),
    },
    {
      key: 'purchase_date_not_a_date',
      label: 'Fecha de compra con valor que no es fecha',
      value: has('purchaseDate', nonDate),
      base: total,
      detail: [...nonDateTypes.entries()].map(([kind, count]) => `${kind}: ${count}`).join(', '),
    },
    { key: 'purchase_date_epoch', label: 'Fecha de compra 1970-01-01', value: has('purchaseDate', epochDate), base: total },
    { key: 'price_zero', label: 'Precio de compra en 0', value: has('price', zeroPrice), base: total },
    { key: 'price_missing', label: 'Precio de compra vacío', value: has('price', missingPrice), base: total },
    { key: 'price_not_a_number', label: 'Precio de compra no numérico', value: has('price', nonNumericPrice), base: total },
    {
      key: 'cost_center_unknown_codes',
      label: 'Centros de costo inexistentes',
      value: letters.costCenter && costCenterCodes ? unknownCenters.size : null,
      base: null,
      detail: [...unknownCenters.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'es', { numeric: true }))
        .map(([code, count]) => `${code} (${count})`)
        .join(', '),
    },
    {
      key: 'cost_center_unknown_assets',
      label: 'Activos en centros de costo inexistentes',
      value:
        letters.costCenter && costCenterCodes
          ? [...unknownCenters.values()].reduce((sum, count) => sum + count, 0)
          : null,
      base: total,
    },
    {
      key: 'serial_empty',
      label: `${header('serial')} vacío`,
      value: has('serial', serialEmpty),
      base: total,
      detail: percent(serialEmpty, total),
    },
    {
      key: 'model_empty',
      label: `${header('model')} vacío`,
      value: has('model', modelEmpty),
      base: total,
      detail: percent(modelEmpty, total),
    },
  ];
  if (letters.writeOffFlag) {
    metrics.push(
      { key: 'written_off', label: `Filas con ${header('writeOffFlag')} verdadero`, value: writtenOff.length, base: total },
      {
        key: 'write_off_date_present',
        label: 'Bajas con fecha de baja',
        value: writeOffDates.length,
        base: writtenOff.length,
        detail: writeOffDates.length > 0
          ? `${percent(writeOffDates.length, writtenOff.length)}; de ${writeOffDates[0]} a ${writeOffDates.at(-1)}`
          : percent(0, writtenOff.length),
      },
      { key: 'write_off_date_missing', label: 'Bajas sin fecha de baja', value: writeOffMissing, base: writtenOff.length, detail: percent(writeOffMissing, writtenOff.length) },
      { key: 'write_off_date_not_a_date', label: 'Fecha de baja que no es fecha', value: writeOffNotADate, base: writtenOff.length },
      { key: 'write_off_before_purchase', label: 'Baja anterior a la compra', value: writeOffBeforePurchase, base: writtenOff.length },
      { key: 'write_off_date_future', label: 'Fecha de baja en el futuro', value: writeOffFuture, base: writtenOff.length },
    );
  }
  return { metrics, issues };
};
