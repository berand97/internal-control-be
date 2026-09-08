import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';

export interface DepreciationAssetInput {
  readonly id: string;
  readonly acquisitionDate: string;
  readonly acquisitionPrice: number;
  readonly salvageValue: number;
  readonly usefulLifeYears: number | null;
  readonly method: DepreciationMethod;
  readonly operationalStatus: OperationalStatus;
  readonly writtenOffAt: string | null;
  readonly costCenterId: string;
  readonly categoryId: string;
}

export type DepreciationSkipReason =
  | 'ZERO_PRICE'
  | 'NO_USEFUL_LIFE'
  | 'METHOD_NONE'
  | 'NOT_STARTED'
  | 'WRITTEN_OFF_BEFORE';

export interface DepreciationSkip {
  readonly assetId: string;
  readonly reason: DepreciationSkipReason;
}

export interface DepreciationSnapshot {
  readonly assetId: string;
  readonly method: DepreciationMethod;
  readonly monthlyDepreciation: string;
  readonly accumulatedDepreciation: string;
  readonly bookValue: string;
  readonly costCenterId: string;
  readonly categoryId: string;
}

export interface DepreciationCalculation {
  readonly snapshots: ReadonlyArray<DepreciationSnapshot>;
  readonly excluded: ReadonlyArray<DepreciationSkip>;
}

const money = (cents: number): string => (cents / 100).toFixed(2);

const toCents = (value: number): number => Math.round(value * 100);

const parseIsoDate = (
  value: string,
): { readonly year: number; readonly month: number; readonly day: number } => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return { year, month, day };
};

const periodIndex = (year: number, month: number): number => year * 12 + month;

export const daysInMonth = (year: number, month: number): number =>
  new Date(year, month, 0).getDate();

export const firstDepreciationPeriod = (
  acquisitionDate: string,
): { readonly year: number; readonly month: number } => {
  const parsed = parseIsoDate(acquisitionDate);
  if (parsed.month === 12) {
    return { year: parsed.year + 1, month: 1 };
  }
  return { year: parsed.year, month: parsed.month + 1 };
};

export const calculateAssetDepreciation = (
  asset: DepreciationAssetInput,
  year: number,
  month: number,
): DepreciationSnapshot | DepreciationSkip => {
  if (asset.acquisitionPrice <= 0) {
    return { assetId: asset.id, reason: 'ZERO_PRICE' };
  }
  if (asset.usefulLifeYears === null || asset.usefulLifeYears <= 0) {
    return { assetId: asset.id, reason: 'NO_USEFUL_LIFE' };
  }
  if (asset.method === DepreciationMethod.None) {
    return { assetId: asset.id, reason: 'METHOD_NONE' };
  }
  const first = firstDepreciationPeriod(asset.acquisitionDate);
  const elapsed =
    periodIndex(year, month) - periodIndex(first.year, first.month) + 1;
  if (elapsed < 1) {
    return { assetId: asset.id, reason: 'NOT_STARTED' };
  }
  if (asset.writtenOffAt) {
    const written = parseIsoDate(asset.writtenOffAt);
    if (periodIndex(written.year, written.month) < periodIndex(year, month)) {
      return { assetId: asset.id, reason: 'WRITTEN_OFF_BEFORE' };
    }
  }

  const price = toCents(asset.acquisitionPrice);
  const salvage = toCents(asset.salvageValue);
  const depreciable = Math.max(price - salvage, 0);
  const totalMonths = asset.usefulLifeYears * 12;
  const fullMonthly = Math.floor(depreciable / totalMonths);
  const previousMonths = Math.min(elapsed - 1, totalMonths);
  const previousAccum = Math.min(fullMonthly * previousMonths, depreciable);

  let thisMonth = 0;
  if (elapsed <= totalMonths) {
    thisMonth = fullMonthly;
    if (elapsed === totalMonths) {
      thisMonth = depreciable - previousAccum;
    }
    if (asset.writtenOffAt) {
      const written = parseIsoDate(asset.writtenOffAt);
      if (periodIndex(written.year, written.month) === periodIndex(year, month)) {
        const days = daysInMonth(year, month);
        thisMonth = Math.round((thisMonth * written.day) / days);
      }
    }
  }

  const accumulated = Math.min(previousAccum + thisMonth, depreciable);
  const book = price - accumulated;

  return {
    assetId: asset.id,
    method: asset.method,
    monthlyDepreciation: money(thisMonth),
    accumulatedDepreciation: money(accumulated),
    bookValue: money(book),
    costCenterId: asset.costCenterId,
    categoryId: asset.categoryId,
  };
};

export const calculatePeriodDepreciation = (
  assets: ReadonlyArray<DepreciationAssetInput>,
  year: number,
  month: number,
): DepreciationCalculation => {
  const snapshots: DepreciationSnapshot[] = [];
  const excluded: DepreciationSkip[] = [];
  for (const asset of assets) {
    const result = calculateAssetDepreciation(asset, year, month);
    if ('reason' in result) {
      excluded.push(result);
    } else {
      snapshots.push(result);
    }
  }
  return { snapshots, excluded };
};
