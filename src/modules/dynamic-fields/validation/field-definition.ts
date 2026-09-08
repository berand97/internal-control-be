import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { DynamicFieldType } from '../enums/dynamic-field-type.enum.js';

export interface FieldValidationRules {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export const assertFieldDefinition = (
  type: DynamicFieldType,
  selectOptions: ReadonlyArray<string> | null,
  validationRules: FieldValidationRules | null,
): void => {
  if (type === DynamicFieldType.Select) {
    if (!selectOptions || selectOptions.length === 0) {
      throw new ApiException(ErrorCode.InvalidFieldDefinition);
    }
    return;
  }
  if (selectOptions && selectOptions.length > 0) {
    throw new ApiException(ErrorCode.InvalidFieldDefinition);
  }
  if (!validationRules) {
    return;
  }
  if (type === DynamicFieldType.Number) {
    if (
      validationRules.min !== undefined &&
      validationRules.max !== undefined &&
      validationRules.min > validationRules.max
    ) {
      throw new ApiException(ErrorCode.InvalidFieldDefinition);
    }
    return;
  }
  if (type === DynamicFieldType.String) {
    if (
      validationRules.minLength !== undefined &&
      validationRules.maxLength !== undefined &&
      validationRules.minLength > validationRules.maxLength
    ) {
      throw new ApiException(ErrorCode.InvalidFieldDefinition);
    }
    if (validationRules.pattern) {
      try {
        new RegExp(validationRules.pattern);
      } catch {
        throw new ApiException(ErrorCode.InvalidFieldDefinition);
      }
    }
    return;
  }
  if (
    validationRules.min !== undefined ||
    validationRules.max !== undefined ||
    validationRules.minLength !== undefined ||
    validationRules.maxLength !== undefined ||
    validationRules.pattern !== undefined
  ) {
    throw new ApiException(ErrorCode.InvalidFieldDefinition);
  }
};

export const validateDynamicValue = (
  type: DynamicFieldType,
  value: unknown,
  selectOptions: ReadonlyArray<string> | null,
  rules: FieldValidationRules | null,
): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  switch (type) {
    case DynamicFieldType.String: {
      if (typeof value !== 'string') {
        return false;
      }
      if (rules?.minLength !== undefined && value.length < rules.minLength) {
        return false;
      }
      if (rules?.maxLength !== undefined && value.length > rules.maxLength) {
        return false;
      }
      if (rules?.pattern && !new RegExp(rules.pattern).test(value)) {
        return false;
      }
      return true;
    }
    case DynamicFieldType.Number: {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return false;
      }
      if (rules?.min !== undefined && value < rules.min) {
        return false;
      }
      if (rules?.max !== undefined && value > rules.max) {
        return false;
      }
      return true;
    }
    case DynamicFieldType.Boolean:
      return typeof value === 'boolean';
    case DynamicFieldType.Date:
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case DynamicFieldType.Select:
      return typeof value === 'string' && (selectOptions?.includes(value) ?? false);
    default:
      return false;
  }
};
