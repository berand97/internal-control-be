import { describe, expect, it } from 'vitest';
import {
  coverageOf,
  firstActBlockedReason,
  locationAccuracyOf,
  percentOrNull,
  roundOne,
} from './inventory-metrics.js';
import { VerificationResult } from '../enums/verification-result.js';
import type { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';

const item = (result: VerificationResult, extra: Partial<PhysicalInventoryItem> = {}): PhysicalInventoryItem =>
  ({
    id: crypto.randomUUID(),
    inventoryId: 'inv',
    assetId: 'a1',
    verificationResult: result,
    expectedLocationId: null,
    actualLocationId: null,
    expectedCondition: null,
    actualCondition: null,
    expectedCostCenterId: null,
    isOnLoan: false,
    verifiedAt: null,
    verifiedBy: null,
    notes: null,
    photoUrl: null,
    findingCategoryCode: null,
    missingCauseId: null,
    missingCauseOther: null,
    expectedCodeTemporary: false,
    wasLost: false,
    voidedAt: null,
    surplusResolution: null,
    surplusResolutionReason: null,
    surplusCostCenterId: null,
    resolvedAssetId: null,
    resolvedAt: null,
    resolvedBy: null,
    ...extra,
  }) as PhysicalInventoryItem;

describe('inventory-metrics', () => {
  it('redondea a un decimal y devuelve null si el denominador es 0', () => {
    expect(roundOne(69.84)).toBe(69.8);
    expect(percentOrNull(74, 106)).toBe(69.8);
    expect(percentOrNull(0, 0)).toBeNull();
  });

  it('calcula cobertura excluyendo sobrantes', () => {
    const items = [
      item(VerificationResult.Found),
      item(VerificationResult.Misplaced),
      item(VerificationResult.Pending),
      item(VerificationResult.Surplus),
    ];
    expect(coverageOf(items)).toEqual({ verified: 2, expected: 3, percent: 66.7 });
  });

  it('calcula exactitud de ubicación solo sobre atendidos', () => {
    const items = [
      item(VerificationResult.Found),
      item(VerificationResult.Found),
      item(VerificationResult.Misplaced),
      item(VerificationResult.Pending),
      item(VerificationResult.Missing),
    ];
    expect(locationAccuracyOf(items)).toEqual({
      inPlace: 2,
      misplaced: 1,
      attended: 3,
      percent: 66.7,
    });
  });

  it('elige el primer motivo de bloqueo de acta en orden', () => {
    expect(
      firstActBlockedReason({
        coveragePercent: 80,
        coverageTarget: 95,
        missingWithoutCause: 1,
        unresolvedSurplus: 1,
        hasSigner: false,
      }),
    ).toBe('COVERAGE_BELOW_TARGET');
    expect(
      firstActBlockedReason({
        coveragePercent: 96,
        coverageTarget: 95,
        missingWithoutCause: 0,
        unresolvedSurplus: 0,
        hasSigner: true,
      }),
    ).toBeNull();
    expect(
      firstActBlockedReason({
        coveragePercent: 96,
        coverageTarget: 95,
        missingWithoutCause: 0,
        unresolvedSurplus: 0,
        hasSigner: true,
        agreementStatus: 'PENDING',
      }),
    ).toBe('AGREEMENT_PENDING');
    expect(
      firstActBlockedReason({
        coveragePercent: 96,
        coverageTarget: 95,
        missingWithoutCause: 0,
        unresolvedSurplus: 0,
        hasSigner: true,
        agreementStatus: 'OBJECTED',
      }),
    ).toBe('AGREEMENT_OBJECTED');
    expect(
      firstActBlockedReason({
        coveragePercent: 96,
        coverageTarget: 95,
        missingWithoutCause: 0,
        unresolvedSurplus: 0,
        hasSigner: true,
        agreementStatus: 'AGREED',
      }),
    ).toBeNull();
  });
});
