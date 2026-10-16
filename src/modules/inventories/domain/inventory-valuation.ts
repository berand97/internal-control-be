export const BOOK_VALUE_SOURCES = ['ACCOUNTING_CUT', 'DEPRECIATION'] as const;
export type BookValueSource = (typeof BOOK_VALUE_SOURCES)[number];

export const RECONCILIATION_BASIS_KINDS = ['ACCOUNTING_CUT', 'SYSTEM_SNAPSHOT'] as const;
export type ReconciliationBasisKind = (typeof RECONCILIATION_BASIS_KINDS)[number];

export interface AssetValuation {
  readonly acquisitionPrice: number | null;
  readonly priceIsZero: boolean;
  readonly bookValue: number | null;
  readonly bookValueSource: BookValueSource | null;
}

export interface AssetIdentity {
  readonly code: string;
  readonly description: string;
  readonly legacyCode: string | null;
}

export const NO_VALUATION: AssetValuation = {
  acquisitionPrice: null,
  priceIsZero: false,
  bookValue: null,
  bookValueSource: null,
};

export interface ReconciliationBasis {
  readonly kind: ReconciliationBasisKind;
  readonly cutId: string | null;
  readonly cutDate: string | null;
  readonly sourceLabel: string | null;
  readonly snapshotAt: Date | null;
  readonly snapshotDate: string | null;
  readonly valuationDate: string;
}

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
