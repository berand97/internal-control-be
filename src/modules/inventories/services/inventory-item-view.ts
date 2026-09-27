import { type SuggestibleCategory, suggestFindingCategory } from '../domain/finding-suggestion.js';
import type { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { VerificationResult } from '../enums/verification-result.js';

/**
 * Serialización de ítems, progreso y reporte de una toma (InventoryItemDto, InventoryProgressDto e
 * InventoryReportDto en dto/inventory.responses.ts: cambiar un shape exige cambiar ambos).
 */
export interface ItemViewContext {
  readonly categories: ReadonlyArray<SuggestibleCategory>;
  readonly causeLabels: ReadonlyMap<string, string>;
}

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
