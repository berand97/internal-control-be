import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { VerificationResult } from '../enums/verification-result.js';
import type { AssetValuation, ReconciliationBasis } from './inventory-valuation.js';

/**
 * Contenido del acta OCI-21-37 (acta de toma física): campos, tablas y campos por activo que la solicitud del motor
 * de actas lleva. Función pura: InventoryActService reúne los datos y esto arma el texto. El contrato de marcadores
 * está documentado en INVENTORY_ACT_PLACEHOLDERS.
 */

export const INVENTORY_ACT_FORMAT_KEY = 'OCI-21-37';
export const INVENTORY_ACT_ENTITY_TYPE = 'PHYSICAL_INVENTORY';

export const INVENTORY_ACT_GENERATIONS = ['NONE', 'PENDING', 'FAILED', 'GENERATED', 'NOT_ENQUEUED'] as const;
export type InventoryActGeneration = (typeof INVENTORY_ACT_GENERATIONS)[number];

/**
 * Por qué el acta no está: FORMAT_NOT_READY (sin código SGC o firmantes), ENQUEUE_FAILED (error inesperado al encolar),
 * TEMPLATE_NOT_ACTIVE (encolada, pero sin plantilla vigente), GENERATION_FAILED (otro error del motor),
 * NO_COST_CENTER_HEAD (no hay jefe vigente del centro de la toma que firme como ENCARGADO; se indica con
 * PUT /inventories/:id/signer-head y se encola de nuevo).
 */
export const INVENTORY_ACT_REASONS = [
  'FORMAT_NOT_READY',
  'NO_COST_CENTER_HEAD',
  'ENQUEUE_FAILED',
  'TEMPLATE_NOT_ACTIVE',
  'GENERATION_FAILED',
] as const;
export type InventoryActReason = (typeof INVENTORY_ACT_REASONS)[number];

export const INVENTORY_ACT_RETRY_ACTIONS = ['ENQUEUE', 'RETRY_REQUEST'] as const;
export type InventoryActRetryAction = (typeof INVENTORY_ACT_RETRY_ACTIONS)[number];

/** Texto de un valor que no se tiene: nunca un 0 inventado. */
export const NO_DATA = 'Sin dato';

export const RESULT_LABELS: Readonly<Record<VerificationResult, string>> = {
  [VerificationResult.Pending]: 'Pendiente',
  [VerificationResult.Found]: 'Encontrado',
  [VerificationResult.Misplaced]: 'En otra ubicación',
  [VerificationResult.Missing]: 'No encontrado',
  [VerificationResult.NotVerified]: 'No verificado',
  [VerificationResult.Surplus]: 'Sobrante',
};

const RESULT_ORDER: ReadonlyArray<VerificationResult> = [
  VerificationResult.Found,
  VerificationResult.Misplaced,
  VerificationResult.Missing,
  VerificationResult.NotVerified,
  VerificationResult.Pending,
  VerificationResult.Surplus,
];

export interface ActItem {
  readonly id: string;
  readonly assetId: string | null;
  readonly result: VerificationResult;
  readonly actualCondition: PhysicalCondition | null;
  readonly expectedCodeTemporary: boolean | null;
  readonly findingCategoryCode: string | null;
  readonly missingCauseId: string | null;
  readonly missingCauseOther: string | null;
  readonly notes: string | null;
  readonly voided: boolean;
  readonly actualLocationName: string | null;
  readonly resolvedAssetId: string | null;
  readonly resolvedAssetCode: string | null;
  readonly surplusResolution: string | null;
  readonly surplusResolutionReason: string | null;
}

export interface ActCategory {
  readonly code: string;
  readonly label: string;
}

export interface ActInput {
  readonly code: string;
  readonly name: string;
  readonly scopeLabel: string;
  readonly plannedStartDate: string;
  readonly plannedEndDate: string;
  readonly actualStartDate: string | null;
  readonly actualEndDate: string | null;
  readonly approvedAt: Date;
  readonly basis: ReconciliationBasis;
  readonly items: ReadonlyArray<ActItem>;
  /** Categorías activas y definidas del catálogo, en su orden. */
  readonly categories: ReadonlyArray<ActCategory>;
  readonly causeLabels: ReadonlyMap<string, string>;
  readonly valuations: ReadonlyMap<string, AssetValuation>;
  readonly conditionLabels: Readonly<Record<string, string>>;
  /** Quién atendió la toma por el área (persona o texto libre); solo informativo, no firma. */
  readonly attendedBy?: string | null;
}

export interface ActContent {
  readonly assetIds: string[];
  readonly assetNotes: Record<string, string>;
  readonly assetFields: Record<string, Record<string, string>>;
  readonly fields: Record<string, string>;
  readonly tables: Record<string, Array<Record<string, string>>>;
}

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatMoney = (value: number | null): string => (value === null ? NO_DATA : money.format(value));

export const formatPercent = (part: number, total: number): string =>
  `${(total === 0 ? 0 : (part / total) * 100).toFixed(2).replace('.', ',')} %`;

/** Base del porcentaje de hallazgos (campos.basePorcentaje): lo dice el acta. */
export const FINDINGS_PERCENT_BASE = 'Porcentaje calculado sobre el precio de compra';

/** Parte de un total en pesos: "Sin dato" si falta alguno de los dos o el total es 0 (nunca un 0 % inventado). */
export const formatValuePercent = (part: number | null, total: number | null): string =>
  part === null || total === null || total === 0 ? NO_DATA : formatPercent(part, total);

export const formatLongDate = (isoDate: string | null): string => {
  if (!isoDate) {
    return '';
  }
  const [year, month, day] = isoDate.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)),
  );
};

const bogotaIsoDate = (instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );

/** Suma de valores; null si falta alguno (el total no se puede afirmar). */
const sumOrNull = (values: ReadonlyArray<number | null>): number | null =>
  values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);

const valuedAssetOf = (item: ActItem): string | null => item.assetId ?? item.resolvedAssetId;

export const buildInventoryActContent = (input: ActInput): ActContent => {
  const live = input.items.filter((item) => !item.voided);
  const valuationOf = (item: ActItem): AssetValuation | undefined => {
    const assetId = valuedAssetOf(item);
    return assetId ? input.valuations.get(assetId) : undefined;
  };
  const conditionText = (condition: PhysicalCondition | null): string =>
    condition ? (input.conditionLabels[condition] ?? condition) : 'Sin verificar';
  const causeText = (item: ActItem): string =>
    item.missingCauseId ? (input.causeLabels.get(item.missingCauseId) ?? '') : (item.missingCauseOther ?? '');
  const categoryLabels = new Map(input.categories.map((category) => [category.code, category.label]));

  const withAsset = live
    .filter((item) => valuedAssetOf(item) !== null)
    .sort((left, right) => RESULT_ORDER.indexOf(left.result) - RESULT_ORDER.indexOf(right.result));
  const assetIds: string[] = [];
  const assetNotes: Record<string, string> = {};
  const assetFields: Record<string, Record<string, string>> = {};
  for (const item of withAsset) {
    const assetId = valuedAssetOf(item) as string;
    if (assetFields[assetId]) {
      continue;
    }
    const valuation = valuationOf(item);
    assetIds.push(assetId);
    if (item.notes?.trim()) {
      assetNotes[assetId] = item.notes.trim();
    }
    assetFields[assetId] = {
      resultado: RESULT_LABELS[item.result],
      categoria: item.findingCategoryCode ? (categoryLabels.get(item.findingCategoryCode) ?? item.findingCategoryCode) : '',
      categoriaCodigo: item.findingCategoryCode ?? '',
      causa: causeText(item),
      condicionObservada: conditionText(item.actualCondition),
      valorCompra: formatMoney(valuation?.acquisitionPrice ?? null),
      valorLibros: formatMoney(valuation?.bookValue ?? null),
      codigoTemporal: item.expectedCodeTemporary === true ? 'Sí' : 'No',
      sobranteResuelto: item.resolvedAssetId ? 'Sí' : 'No',
    };
  }

  const findingRows = input.categories.map((category) => {
    const members = live.filter((item) => item.findingCategoryCode === category.code);
    return {
      category,
      count: members.length,
      // Una categoría sin bienes suma 0 de verdad; con bienes, null si falta el valor de alguno.
      price: members.length === 0 ? 0 : sumOrNull(members.map((item) => valuationOf(item)?.acquisitionPrice ?? null)),
      book: members.length === 0 ? 0 : sumOrNull(members.map((item) => valuationOf(item)?.bookValue ?? null)),
    };
  });
  const categorized = findingRows.reduce((total, row) => total + row.count, 0);
  const totalPrice = sumOrNull(findingRows.map((row) => row.price));
  const totalBook = sumOrNull(findingRows.map((row) => row.book));
  // Porcentaje sobre el precio de compra (no sobre el número de bienes): la parte de la categoría en el precio de
  // compra total de las categorías. Sin precio de algún bien o con total 0: "Sin dato".
  const hallazgos = findingRows.map((row) => ({
    codigo: row.category.code,
    nombre: row.category.label,
    cantidad: String(row.count),
    valorCompra: formatMoney(row.price),
    porcentaje: formatValuePercent(row.price, totalPrice),
    valorLibros: formatMoney(row.book),
    esTotal: '',
  }));
  hallazgos.push({
    codigo: 'TOTAL',
    nombre: 'Total',
    cantidad: String(categorized),
    valorCompra: formatMoney(totalPrice),
    porcentaje: formatValuePercent(totalPrice, totalPrice),
    valorLibros: formatMoney(totalBook),
    esTotal: 'Sí',
  });

  const unregisteredSurplus = live.filter(
    (item) => item.result === VerificationResult.Surplus && item.assetId === null,
  );
  const sobrantes = unregisteredSurplus.map((item, index) => ({
    indice: String(index + 1),
    descripcion: item.notes?.trim() ?? '',
    ubicacion: item.actualLocationName ?? '',
    condicion: conditionText(item.actualCondition),
    resolucion:
      item.surplusResolution === 'CREATE_ASSET'
        ? 'Registrado como activo'
        : item.surplusResolution === 'LEAVE_UNRESOLVED'
          ? 'Sin resolver'
          : 'Sin decisión',
    motivoResolucion: item.surplusResolutionReason ?? '',
    activoCreado: item.resolvedAssetCode ?? '',
  }));

  const expected = live.filter((item) => item.result !== VerificationResult.Surplus);
  const count = (...results: VerificationResult[]) => expected.filter((item) => results.includes(item.result)).length;
  const verified = count(VerificationResult.Found, VerificationResult.Misplaced);
  const basis = input.basis;
  const cutText =
    basis.kind === 'ACCOUNTING_CUT'
      ? formatLongDate(basis.cutDate)
      : `Sin corte contable: estado del sistema al ${formatLongDate(basis.snapshotDate ?? basis.valuationDate)}`;

  return {
    assetIds,
    assetNotes,
    assetFields,
    fields: {
      tomaCodigo: input.code,
      tomaNombre: input.name,
      alcance: input.scopeLabel,
      fechaProgramadaInicio: formatLongDate(input.plannedStartDate),
      fechaProgramadaFin: formatLongDate(input.plannedEndDate),
      fechaInicio: formatLongDate(input.actualStartDate),
      fechaCierre: formatLongDate(input.actualEndDate),
      fechaAprobacion: formatLongDate(bogotaIsoDate(input.approvedAt)),
      corteContable: cutText,
      fuenteCorte: basis.kind === 'ACCOUNTING_CUT' ? (basis.sourceLabel ?? '') : '',
      baseConciliacion: basis.kind === 'ACCOUNTING_CUT' ? 'Corte contable' : 'Estado del sistema',
      totalEsperados: String(expected.length),
      totalVerificados: String(verified),
      totalEncontrados: String(count(VerificationResult.Found)),
      totalOtraUbicacion: String(count(VerificationResult.Misplaced)),
      totalFaltantes: String(count(VerificationResult.Missing)),
      totalNoVerificados: String(count(VerificationResult.NotVerified)),
      totalSobrantes: String(live.filter((item) => item.result === VerificationResult.Surplus).length),
      totalSobrantesSinActivo: String(unregisteredSurplus.length),
      porcentajeVerificado: formatPercent(verified, expected.length),
      totalConCategoria: String(categorized),
      totalSinCategoria: String(live.length - categorized),
      hallazgosValorCompra: formatMoney(totalPrice),
      hallazgosValorLibros: formatMoney(totalBook),
      basePorcentaje: FINDINGS_PERCENT_BASE,
      atendioPorArea: input.attendedBy?.trim() || NO_DATA,
    },
    tables: { hallazgos, sobrantes },
  };
};

/** Marcadores del acta OCI-21-37, para quien arma la plantilla (además de los comunes del motor). */
export const INVENTORY_ACT_PLACEHOLDERS: ReadonlyArray<readonly [string, string]> = [
  ['campos.tomaCodigo', 'Código de la toma (TF-2026-001)'],
  ['campos.tomaNombre', 'Nombre de la toma'],
  ['campos.alcance', 'Alcance: "Centro de costo 1020 — Nombre", "Ubicación …", "Unidad organizacional …" o "Toda la universidad"'],
  ['campos.fechaProgramadaInicio / campos.fechaProgramadaFin', 'Fechas planeadas ("15 de marzo de 2026")'],
  ['campos.fechaInicio / campos.fechaCierre / campos.fechaAprobacion', 'Fechas reales de inicio, cierre y aprobación de la conciliación'],
  ['campos.corteContable', 'Fecha del corte contable o "Sin corte contable: estado del sistema al <fecha de la foto>"'],
  ['campos.fuenteCorte', 'Fuente del corte ("" sin corte)'],
  ['campos.baseConciliacion', '"Corte contable" o "Estado del sistema"'],
  ['campos.totalEsperados / totalVerificados / totalEncontrados / totalOtraUbicacion / totalFaltantes / totalNoVerificados', 'Conteos de la foto'],
  ['campos.totalSobrantes / campos.totalSobrantesSinActivo', 'Sobrantes vigentes y los que no tenían activo registrado'],
  ['campos.porcentajeVerificado', 'Verificados / esperados ("93,50 %")'],
  ['campos.totalConCategoria / campos.totalSinCategoria', 'Ítems con y sin categoría de hallazgo'],
  ['campos.hallazgosValorCompra / campos.hallazgosValorLibros', 'Totales de la tabla de hallazgos ("Sin dato" si falta algún valor)'],
  ['campos.basePorcentaje', '"Porcentaje calculado sobre el precio de compra": base del porcentaje de hallazgos'],
  ['campos.atendioPorArea', 'Quién atendió la toma por el área (persona o texto libre; "Sin dato" si no se indicó). Solo informativo: no firma'],
  ['tablas.hallazgos[] (codigo, nombre, cantidad, valorCompra, porcentaje, valorLibros, esTotal)', 'Una fila por categoría activa del catálogo y una final TOTAL (esTotal = "Sí"); porcentaje = precio de compra de la categoría / precio de compra total de las categorías ("Sin dato" si falta algún precio o el total es 0). El valor en libros no entra en el porcentaje'],
  ['tablas.sobrantes[] (indice, descripcion, ubicacion, condicion, resolucion, motivoResolucion, activoCreado)', 'Sobrantes sin activo registrado'],
  ['activos[].campos.resultado / categoria / categoriaCodigo / causa / condicionObservada', 'Resultado en español, categoría de hallazgo, causa del faltante y condición observada'],
  ['activos[].campos.valorCompra / valorLibros', 'Precio de compra y valor en libros ("Sin dato" si no hay)'],
  ['activos[].campos.codigoTemporal / sobranteResuelto', '"Sí" o "No"'],
  ['activos[].observacion', 'Notas del ítem'],
];
