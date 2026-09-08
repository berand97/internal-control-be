import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { DynamicFieldType } from '../enums/dynamic-field-type.enum.js';
import {
  assertFieldDefinition,
  validateDynamicValue,
} from './field-definition.js';

const expectInvalidDefinition = (run: () => void): void => {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ code: ErrorCode.InvalidFieldDefinition });
  }
};

describe('assertFieldDefinition', () => {
  it('exige opciones en SELECT y las prohíbe en los demás tipos', () => {
    expectInvalidDefinition(() =>
      assertFieldDefinition(DynamicFieldType.Select, null, null),
    );
    expectInvalidDefinition(() =>
      assertFieldDefinition(DynamicFieldType.String, ['A'], null),
    );
    expect(() =>
      assertFieldDefinition(DynamicFieldType.Select, ['Windows', 'Linux'], null),
    ).not.toThrow();
  });

  it('rechaza reglas min > max y patrones inválidos', () => {
    expectInvalidDefinition(() =>
      assertFieldDefinition(DynamicFieldType.Number, null, { min: 10, max: 1 }),
    );
    expectInvalidDefinition(() =>
      assertFieldDefinition(DynamicFieldType.String, null, { pattern: '(' }),
    );
  });
});

describe('validateDynamicValue', () => {
  it('valida STRING con longitud y patrón', () => {
    expect(
      validateDynamicValue(DynamicFieldType.String, 'abc', null, {
        minLength: 2,
        maxLength: 8,
        pattern: '^[a-z]+$',
      }),
    ).toBe(true);
    expect(
      validateDynamicValue(DynamicFieldType.String, 'A1', null, {
        pattern: '^[a-z]+$',
      }),
    ).toBe(false);
    expect(validateDynamicValue(DynamicFieldType.String, 12, null, null)).toBe(
      false,
    );
  });

  it('valida NUMBER con min y max', () => {
    expect(
      validateDynamicValue(DynamicFieldType.Number, 16, null, {
        min: 4,
        max: 128,
      }),
    ).toBe(true);
    expect(
      validateDynamicValue(DynamicFieldType.Number, 2, null, { min: 4 }),
    ).toBe(false);
    expect(validateDynamicValue(DynamicFieldType.Number, '16', null, null)).toBe(
      false,
    );
  });

  it('valida BOOLEAN, DATE y SELECT', () => {
    expect(validateDynamicValue(DynamicFieldType.Boolean, true, null, null)).toBe(
      true,
    );
    expect(
      validateDynamicValue(DynamicFieldType.Boolean, 'true', null, null),
    ).toBe(false);
    expect(
      validateDynamicValue(DynamicFieldType.Date, '2026-10-31', null, null),
    ).toBe(true);
    expect(
      validateDynamicValue(DynamicFieldType.Date, 'no-es-fecha', null, null),
    ).toBe(false);
    expect(
      validateDynamicValue(
        DynamicFieldType.Select,
        'Linux',
        ['Windows', 'macOS', 'Linux'],
        null,
      ),
    ).toBe(true);
    expect(
      validateDynamicValue(
        DynamicFieldType.Select,
        'Android',
        ['Windows', 'macOS', 'Linux'],
        null,
      ),
    ).toBe(false);
  });
});
