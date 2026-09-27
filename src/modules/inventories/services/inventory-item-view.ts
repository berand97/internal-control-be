import { type SuggestibleCategory, suggestFindingCategory } from '../domain/finding-suggestion.js';
import type { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { VerificationResult } from '../enums/verification-result.js';
import { type AssetValuation, NO_VALUATION } from '../domain/inventory-valuation.js';

/**
 * Serialización de ítems, progreso y reporte de una toma (InventoryItemDto, InventoryProgressDto e
 * InventoryReportDto en dto/inventory.responses.ts: cambiar un shape exige cambiar ambos).
 */
export interface CatalogViewContext {
  readonly categories: ReadonlyArray<SuggestibleCategory>;
  readonly causeLabels: ReadonlyMap<string, string>;
}

export interface ItemViewContext extends CatalogViewContext {
  /** Valoración por activo (InventoryValuationService); el activo del ítem o, en un sobrante resuelto, el creado. */
  readonly valuations: ReadonlyMap<string, AssetValuation>;
}

/** Lo que siempre sale en vivo, aunque el reporte se haya congelado al cerrar. */
const liveItemFields = (item: PhysicalInventoryItem, context: ItemViewContext) => {
  const valuedAsset = item.assetId ?? item.resolvedAssetId ?? null;
  const valuation = (valuedAsset ? context.valuations.get(valuedAsset) : undefined) ?? NO_VALUATION;
  return {
    acquisitionPrice: valuation.acquisitionPrice,
    priceIsZero: valuation.priceIsZero,
    bookValue: valuation.bookValue,
    bookValueSource: valuation.bookValueSource,
    surplusResolution: item.surplusResolution ?? null,
    surplusResolutionReason: item.surplusResolutionReason ?? null,
    resolvedAssetId: item.resolvedAssetId ?? null,
    resolvedAt: item.resolvedAt ?? null,
    resolvedBy: item.resolvedBy ?? null,
  };
};

export const toItemView = (item: PhysicalInventoryItem, context: ItemViewContext) => ({
  id: item.id,
  assetId: item.assetId,
  result: item.verificationResult,
  expectedLocationId: item.expectedLocationId,
  actualLocationId: item.actualLocationId,
  expectedCondition: item.expectedCondition,
  actualCondition: item.actualCondition,
  expectedCostCenterId: item.expectedCostCenterId,
  expectedCodeTemporary: item.expectedCodeTemporary ?? null,
  isOnLoan: item.isOnLoan,
  wasLost: item.wasLost ?? false,
  verifiedAt: item.verifiedAt,
  verifiedBy: item.verifiedBy,
  notes: item.notes,
  missingCauseId: item.missingCauseId ?? null,
  missingCauseLabel: item.missingCauseId ? (context.causeLabels.get(item.missingCauseId) ?? null) : null,
  missingCauseOther: item.missingCauseOther ?? null,
  findingCategory: item.findingCategoryCode ?? null,
  suggestedCategory: item.voidedAt
    ? null
    : suggestFindingCategory(context.categories, {
        result: item.verificationResult,
        actualCondition: item.actualCondition,
      }),
  voided: item.voidedAt !== null && item.voidedAt !== undefined,
  voidedAt: item.voidedAt ?? null,
  ...liveItemFields(item, context),
});

export type InventoryItemView = ReturnType<typeof toItemView>;

const isExpected = (item: PhysicalInventoryItem) => item.verificationResult !== VerificationResult.Surplus;
const isLiveSurplus = (item: PhysicalInventoryItem) =>
  item.verificationResult === VerificationResult.Surplus && !item.voidedAt;
const hasResult = (...results: VerificationResult[]) => (item: PhysicalInventoryItem) =>
  results.includes(item.verificationResult);

export const toProgressView = (items: ReadonlyArray<PhysicalInventoryItem>) => {
  const expected = items.filter(isExpected);
  const verified = expected.filter(hasResult(VerificationResult.Found, VerificationResult.Misplaced)).length;
  return {
    expected: expected.length,
    pending: expected.filter(hasResult(VerificationResult.Pending)).length,
    verified,
    notFound: expected.filter(hasResult(VerificationResult.Missing)).length,
    misplaced: expected.filter(hasResult(VerificationResult.Misplaced)).length,
    notVerified: expected.filter(hasResult(VerificationResult.NotVerified)).length,
    unexpected: items.filter(isLiveSurplus).length,
    voidedUnexpected: items.filter((item) => item.verificationResult === VerificationResult.Surplus && !!item.voidedAt)
      .length,
    onLoan: expected.filter((item) => item.isOnLoan).length,
    temporaryCode: expected.filter((item) => item.expectedCodeTemporary === true).length,
    percentVerified: expected.length === 0 ? 100 : Math.round((verified / expected.length) * 10000) / 100,
  };
};

export const toReportView = (items: ReadonlyArray<PhysicalInventoryItem>, context: ItemViewContext) => {
  const view = (filter: (item: PhysicalInventoryItem) => boolean) =>
    items.filter(filter).map((item) => toItemView(item, context));
  return {
    ...toProgressView(items),
    verifiedItems: view(hasResult(VerificationResult.Found, VerificationResult.Misplaced)),
    notFoundItems: view(hasResult(VerificationResult.Missing)),
    locationDiscrepancies: view(hasResult(VerificationResult.Misplaced)),
    notVerifiedItems: view(hasResult(VerificationResult.NotVerified)),
    unexpectedItems: view(isLiveSurplus),
  };
};

const REPORT_ITEM_LISTS = [
  'verifiedItems',
  'notFoundItems',
  'locationDiscrepancies',
  'notVerifiedItems',
  'unexpectedItems',
] as const;

/**
 * Reporte de una toma cerrada: prevalece lo congelado al cerrar (discrepancy_report), los campos que no existían
 * entonces salen en vivo y la valoración y la resolución de sobrantes salen siempre en vivo.
 */
export const mergeFrozenReport = (
  frozen: Record<string, unknown>,
  items: ReadonlyArray<PhysicalInventoryItem>,
  context: ItemViewContext,
) => {
  const live = toReportView(items, context);
  const byId = new Map(items.map((item) => [item.id, item]));
  const merged: Record<string, unknown> = { ...live, ...frozen };
  for (const list of REPORT_ITEM_LISTS) {
    const frozenList = frozen[list];
    if (!Array.isArray(frozenList)) {
      continue;
    }
    merged[list] = frozenList.map((entry: unknown) => {
      const frozenItem = (typeof entry === 'object' && entry !== null ? entry : {}) as { id?: string };
      const item = frozenItem.id ? byId.get(frozenItem.id) : undefined;
      return item
        ? { ...toItemView(item, context), ...frozenItem, ...liveItemFields(item, context) }
        : frozenItem;
    });
  }
  return merged as typeof live;
};
