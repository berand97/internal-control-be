import { describe, expect, it } from 'vitest';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import {
  calculateAssetDepreciation,
  calculatePeriodDepreciation,
  firstDepreciationPeriod,
} from './calculate-depreciation.js';
import type { DepreciationAssetInput } from './calculate-depreciation.js';

const base = (
  overrides: Partial<DepreciationAssetInput> = {},
): DepreciationAssetInput => ({
  id: 'asset-1',
  acquisitionDate: '2024-01-15',
  acquisitionPrice: 12000,
  salvageValue: 0,
  usefulLifeYears: 4,
  method: DepreciationMethod.StraightLine,
  operationalStatus: OperationalStatus.InUse,
  writtenOffAt: null,
  costCenterId: 'cc-1',
  categoryId: 'cat-1',
  ...overrides,
});

describe('calculate-depreciation', () => {
  it('empieza el mes siguiente a la adquisición', () => {
    expect(firstDepreciationPeriod('2024-01-15')).toEqual({
      year: 2024,
      month: 2,
    });
    expect(firstDepreciationPeriod('2024-12-01')).toEqual({
      year: 2025,
      month: 1,
    });
  });

  it('excluye el mes de compra', () => {
    const result = calculateAssetDepreciation(base(), 2024, 1);
    expect(result).toMatchObject({ reason: 'NOT_STARTED' });
  });

  it('calcula un activo nuevo en su primer mes', () => {
    const result = calculateAssetDepreciation(base(), 2024, 2);
    expect(result).toMatchObject({
      monthlyDepreciation: '250.00',
      accumulatedDepreciation: '250.00',
      bookValue: '11750.00',
    });
  });

  it('calcula un activo a mitad de vida', () => {
    const result = calculateAssetDepreciation(base(), 2026, 1);
    expect(result).toMatchObject({
      monthlyDepreciation: '250.00',
      accumulatedDepreciation: '6000.00',
      bookValue: '6000.00',
    });
  });

  it('deja valor residual al terminar la vida útil', () => {
    const result = calculateAssetDepreciation(
      base({ salvageValue: 1200 }),
      2028,
      2,
    );
    expect(result).toMatchObject({
      monthlyDepreciation: '0.00',
      accumulatedDepreciation: '10800.00',
      bookValue: '1200.00',
    });
  });

  it('prorratea si se da de baja durante el mes', () => {
    const result = calculateAssetDepreciation(
      base({ writtenOffAt: '2024-02-15' }),
      2024,
      2,
    );
    expect(result).toMatchObject({
      monthlyDepreciation: '129.31',
      accumulatedDepreciation: '129.31',
      bookValue: '11870.69',
    });
  });

  it('excluye un activo dado de baja en un mes anterior', () => {
    const result = calculateAssetDepreciation(
      base({
        writtenOffAt: '2024-02-15',
        operationalStatus: OperationalStatus.WrittenOff,
      }),
      2024,
      3,
    );
    expect(result).toMatchObject({ reason: 'WRITTEN_OFF_BEFORE' });
  });

  it('es idempotente a nivel de fórmula', () => {
    const first = calculatePeriodDepreciation([base()], 2025, 6);
    const second = calculatePeriodDepreciation([base()], 2025, 6);
    expect(first).toEqual(second);
  });

  it('excluye precio 0 y vida útil nula', () => {
    const result = calculatePeriodDepreciation(
      [
        base({ id: 'a', acquisitionPrice: 0 }),
        base({ id: 'b', usefulLifeYears: null }),
      ],
      2025,
      1,
    );
    expect(result.snapshots).toHaveLength(0);
    expect(result.excluded.map((item) => item.reason)).toEqual([
      'ZERO_PRICE',
      'NO_USEFUL_LIFE',
    ]);
  });
});
