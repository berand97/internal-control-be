export const BOOK_VALUE_SOURCES = ['ACCOUNTING_CUT', 'DEPRECIATION'] as const;
export type BookValueSource = (typeof BOOK_VALUE_SOURCES)[number];

export const RECONCILIATION_BASIS_KINDS = ['ACCOUNTING_CUT', 'SYSTEM_SNAPSHOT'] as const;
export type ReconciliationBasisKind = (typeof RECONCILIATION_BASIS_KINDS)[number];

/** Valor de un activo para la toma. bookValue null = sin dato (nunca 0 inventado). */
export interface AssetValuation {
  readonly acquisitionPrice: number | null;
  readonly priceIsZero: boolean;
  readonly bookValue: number | null;
  readonly bookValueSource: BookValueSource | null;
}

export const NO_VALUATION: AssetValuation = {
  acquisitionPrice: null,
  priceIsZero: false,
  bookValue: null,
  bookValueSource: null,
};

/** Contra qué se compara la toma (InventoryReconciliationBasisDto en dto/inventory.responses.ts). */
export interface ReconciliationBasis {
  readonly kind: ReconciliationBasisKind;
  readonly cutId: string | null;
  readonly cutDate: string | null;
  readonly sourceLabel: string | null;
  /** Instante de la foto (start); null si la toma no ha iniciado o se inició antes de guardarlo. */
  readonly snapshotAt: Date | null;
  /** Fecha de Bogotá en que se tomó la foto (actualStartDate). */
  readonly snapshotDate: string | null;
  /** Fecha hasta la que se lee la depreciación: la del corte, la de la foto o, sin foto, hoy. */
  readonly valuationDate: string;
}

/**
 * Valor en libros de la línea del corte (si trae valor) > el de la última depreciación hasta la fecha de valoración >
 * null. Un precio de compra 0 es un precio registrado: se devuelve tal cual y se marca priceIsZero.
 */
export const valuationOf = (
  price: number | null,
  cutValue: number | null,
  depreciationValue: number | null,
): AssetValuation => ({
  acquisitionPrice: price,
  priceIsZero: price === 0,
  bookValue: cutValue ?? depreciationValue,
  bookValueSource: cutValue !== null ? 'ACCOUNTING_CUT' : depreciationValue !== null ? 'DEPRECIATION' : null,
});
