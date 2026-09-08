import { DynamicFieldType } from '../../dynamic-fields/enums/dynamic-field-type.enum.js';
import type { AssetCustomValue } from '../entities/asset-custom-value.entity.js';

export interface CustomValueColumns {
  readonly valueText: string | null;
  readonly valueNumber: string | null;
  readonly valueDate: string | null;
  readonly valueBoolean: boolean | null;
  readonly valueJson: unknown;
}

export const toCustomValueColumns = (
  type: DynamicFieldType,
  value: unknown,
): CustomValueColumns => {
  const empty: CustomValueColumns = {
    valueText: null,
    valueNumber: null,
    valueDate: null,
    valueBoolean: null,
    valueJson: null,
  };
  switch (type) {
    case DynamicFieldType.String:
    case DynamicFieldType.Select:
      return { ...empty, valueText: String(value) };
    case DynamicFieldType.Number:
      return { ...empty, valueNumber: String(value) };
    case DynamicFieldType.Date:
      return { ...empty, valueDate: String(value).slice(0, 10) };
    case DynamicFieldType.Boolean:
      return { ...empty, valueBoolean: Boolean(value) };
    default:
      return empty;
  }
};

export const fromCustomValueColumns = (
  type: DynamicFieldType,
  row: AssetCustomValue,
): unknown => {
  switch (type) {
    case DynamicFieldType.String:
    case DynamicFieldType.Select:
      return row.valueText;
    case DynamicFieldType.Number:
      return row.valueNumber === null ? null : Number(row.valueNumber);
    case DynamicFieldType.Date:
      return row.valueDate;
    case DynamicFieldType.Boolean:
      return row.valueBoolean;
    default:
      return row.valueJson;
  }
};

export const coerceDynamicInput = (
  type: DynamicFieldType,
  value: unknown,
): unknown => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (type === DynamicFieldType.Number && typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === DynamicFieldType.Boolean && typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value === '1') {
      return true;
    }
    if (value.toLowerCase() === 'false' || value === '0') {
      return false;
    }
  }
  return value;
};
