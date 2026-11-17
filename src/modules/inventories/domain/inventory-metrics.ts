import type { AssetValuation } from './inventory-valuation.js';
import type { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { VerificationResult } from '../enums/verification-result.js';

export const ACT_BLOCKED_REASONS = [
  'COVERAGE_BELOW_TARGET',
  'MISSING_WITHOUT_CAUSE',
  'SURPLUS_UNRESOLVED',
  'NO_SIGNER',
  'AGREEMENT_PENDING',
  'AGREEMENT_OBJECTED',
] as const;
export type ActBlockedReason = (typeof ACT_BLOCKED_REASONS)[number];

export const CLOSE_CHECK_CODES = [
  'COVERAGE_TARGET',
  'MISSING_HAVE_CAUSE',
  'MISSING_HAVE_PHOTO',
  'SURPLUS_RESOLVED',
  'SIGNERS_ASSIGNED',
] as const;
export type CloseCheckCode = (typeof CLOSE_CHECK_CODES)[number];

export const roundOne = (value: number): number => Math.round(value * 10) / 10;

export const percentOrNull = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : roundOne((numerator / denominator) * 100);

export const isExpectedItem = (item: PhysicalInventoryItem): boolean =>
  item.verificationResult !== VerificationResult.Surplus;

export const isLiveSurplus = (item: PhysicalInventoryItem): boolean =>
  item.verificationResult === VerificationResult.Surplus && !item.voidedAt;

export const isVerifiedItem = (item: PhysicalInventoryItem): boolean =>
  item.verificationResult === VerificationResult.Found ||
  item.verificationResult === VerificationResult.Misplaced;

export const isMissingWithoutCause = (item: PhysicalInventoryItem): boolean =>
  item.verificationResult === VerificationResult.Missing &&
  !item.missingCauseId &&
  !(item.missingCauseOther?.trim());

export const isUnresolvedSurplus = (item: PhysicalInventoryItem): boolean =>
  isLiveSurplus(item) && !item.surplusResolution;

export const itemPhotoCount = (
  item: PhysicalInventoryItem,
  photoCounts: ReadonlyMap<string, number>,
): number => (photoCounts.get(item.id) ?? 0) + (item.photoUrl ? 1 : 0);

export const coverageOf = (items: ReadonlyArray<PhysicalInventoryItem>) => {
  const expected = items.filter(isExpectedItem);
  const verified = expected.filter(isVerifiedItem).length;
  return {
    verified,
    expected: expected.length,
    percent: percentOrNull(verified, expected.length),
  };
};

export const locationAccuracyOf = (items: ReadonlyArray<PhysicalInventoryItem>) => {
  const inPlace = items.filter((item) => item.verificationResult === VerificationResult.Found).length;
  const misplaced = items.filter((item) => item.verificationResult === VerificationResult.Misplaced).length;
  const attended = inPlace + misplaced;
  return {
    inPlace,
    misplaced,
    attended,
    percent: percentOrNull(inPlace, attended),
  };
};

export const missingStatsOf = (
  items: ReadonlyArray<PhysicalInventoryItem>,
  valuations: ReadonlyMap<string, AssetValuation>,
  materialityAmount: number,
  photoCounts: ReadonlyMap<string, number>,
) => {
  const missing = items.filter((item) => item.verificationResult === VerificationResult.Missing);
  let bookValue = 0;
  let withoutCause = 0;
  let withoutPhoto = 0;
  let aboveMateriality = 0;
  for (const item of missing) {
    if (isMissingWithoutCause(item)) {
      withoutCause += 1;
    }
    if (itemPhotoCount(item, photoCounts) < 1) {
      withoutPhoto += 1;
    }
    const assetId = item.assetId ?? item.resolvedAssetId;
    const value = assetId ? (valuations.get(assetId)?.bookValue ?? null) : null;
    if (value !== null) {
      bookValue += value;
      if (value >= materialityAmount) {
        aboveMateriality += 1;
      }
    }
  }
  return {
    count: missing.length,
    bookValue,
    withoutCause,
    withoutPhoto,
    aboveMateriality,
  };
};

export const surplusStatsOf = (items: ReadonlyArray<PhysicalInventoryItem>) => {
  const surplus = items.filter(isLiveSurplus);
  const resolved = surplus.filter((item) => !!item.surplusResolution).length;
  return {
    count: surplus.length,
    resolved,
    unresolved: surplus.length - resolved,
  };
};

export const firstActBlockedReason = (input: {
  readonly coveragePercent: number | null;
  readonly coverageTarget: number;
  readonly missingWithoutCause: number;
  readonly unresolvedSurplus: number;
  readonly hasSigner: boolean;
  readonly agreementStatus?: 'PENDING' | 'AGREED' | 'OBJECTED';
}): ActBlockedReason | null => {
  if (input.coveragePercent !== null && input.coveragePercent < input.coverageTarget) {
    return 'COVERAGE_BELOW_TARGET';
  }
  if (input.missingWithoutCause > 0) {
    return 'MISSING_WITHOUT_CAUSE';
  }
  if (input.unresolvedSurplus > 0) {
    return 'SURPLUS_UNRESOLVED';
  }
  if (!input.hasSigner) {
    return 'NO_SIGNER';
  }
  if (input.agreementStatus === 'OBJECTED') {
    return 'AGREEMENT_OBJECTED';
  }
  if (input.agreementStatus === 'PENDING') {
    return 'AGREEMENT_PENDING';
  }
  return null;
};
