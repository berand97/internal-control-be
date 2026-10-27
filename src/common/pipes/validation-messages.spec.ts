import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../constants/error-code.enum.js';
import { ApiException } from '../exceptions/api.exception.js';
import { createAppValidationPipe } from './app-validation.pipe.js';
import { translateConstraint } from './validation-messages.js';

enum Color {
  Red = 'RED',
}

class Child {
  @IsString()
  label!: string;
}

class Probe {
  @IsOptional() @IsNotEmpty() required?: string;
  @IsOptional() @IsString() text?: unknown;
  @IsOptional() @MaxLength(200) longText?: string;
  @IsOptional() @MinLength(3) shortText?: string;
  @IsOptional() @MaxLength(1) oneChar?: string;
  @IsOptional() @Length(2, 4) sized?: string;
  @IsOptional() @IsUUID() uuid?: string;
  @IsOptional() @IsInt() whole?: unknown;
  @IsOptional() @IsNumber() amount?: unknown;
  @IsOptional() @IsPositive() positive?: number;
  @IsOptional() @Min(-5) floor?: number;
  @IsOptional() @Max(99) ceiling?: number;
  @IsOptional() @IsEnum(Color) color?: string;
  @IsOptional() @IsIn(['A', 'B']) choice?: string;
  @IsOptional() @Matches(/^\d+$/u) digits?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsBoolean() flag?: unknown;
  @IsOptional() @IsArray() list?: unknown;
  @IsOptional() @ArrayMinSize(2) atLeastTwo?: string[];
  @IsOptional() @ArrayMinSize(1) atLeastOne?: string[];
  @IsOptional() @ArrayMaxSize(3) atMostThree?: string[];
  @IsOptional() @ArrayUnique() unique?: string[];
  @IsOptional() @IsUUID('4', { each: true }) uuids?: string[];
  @IsOptional() @IsObject() bag?: unknown;
  @IsOptional() @MaxLength(5, { message: 'Escriba un código corto.' }) custom?: string;
  @IsOptional() @ValidateNested() @Type(() => Child) child?: Child;
}

const pipe = createAppValidationPipe();

const detailsFor = async (body: Record<string, unknown>) => {
  try {
    await pipe.transform(body, { type: 'body', metatype: Probe });
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe(ErrorCode.ValidationFailed);
    return (error as ApiException).details ?? [];
  }
  throw new Error('La validación no falló');
};

const messageFor = async (field: string, value: unknown) => {
  const details = await detailsFor({ [field]: value });
  return details.filter((detail) => detail.field === field).map((detail) => detail.message);
};

describe('mensajes de validación en español', () => {
  it.each([
    ['required', '', 'Este campo es obligatorio.'],
    ['text', 5, 'Escriba un texto.'],
    ['longText', 'x'.repeat(201), 'Escriba máximo 200 caracteres.'],
    ['shortText', 'ab', 'Escriba al menos 3 caracteres.'],
    ['oneChar', 'ab', 'Escriba máximo 1 carácter.'],
    ['sized', 'a', 'Escriba al menos 2 caracteres.'],
    ['sized', 'abcde', 'Escriba máximo 4 caracteres.'],
    ['uuid', 'abc', 'Elija una opción válida.'],
    ['whole', 1.5, 'Escriba un número entero.'],
    ['amount', 'diez', 'Escriba un número.'],
    ['positive', -1, 'Escriba un número mayor que 0.'],
    ['floor', -6, 'El valor mínimo es -5.'],
    ['ceiling', 100, 'El valor máximo es 99.'],
    ['color', 'BLUE', 'Elija una opción de la lista.'],
    ['choice', 'C', 'Elija una opción de la lista.'],
    ['digits', 'abc', 'El formato no es válido.'],
    ['email', 'no-es-correo', 'Escriba un correo válido.'],
    ['date', 'ayer', 'Escriba una fecha válida.'],
    ['flag', 'si', 'Elija sí o no.'],
    ['list', 'a', 'Envíe una lista.'],
    ['atLeastTwo', ['a'], 'Agregue al menos 2 elementos.'],
    ['atLeastOne', [], 'Agregue al menos 1 elemento.'],
    ['atMostThree', ['a', 'b', 'c', 'd'], 'Agregue máximo 3 elementos.'],
    ['unique', ['a', 'a'], 'Hay valores repetidos.'],
    ['uuids', ['abc'], 'Elija una opción válida.'],
    ['bag', 'a', 'El valor no es válido.'],
  ])('%s con %j', async (field, value, expected) => {
    expect(await messageFor(field, value)).toEqual([expected]);
  });

  it('un campo que no existe en el formulario', async () => {
    expect(await detailsFor({ intruso: 1 })).toEqual([{ field: 'intruso', message: 'Este campo no se permite.' }]);
  });

  it('respeta el mensaje propio del DTO', async () => {
    expect(await messageFor('custom', 'abcdef')).toEqual(['Escriba un código corto.']);
  });

  it('traduce los errores de un objeto anidado con el campo hijo', async () => {
    expect(await detailsFor({ child: { label: 3 } })).toEqual([{ field: 'label', message: 'Escriba un texto.' }]);
  });

  it('una regla sin traducción propia usa un texto general', () => {
    expect(translateConstraint('isLatLong', 'position must be a latitude,longitude string', 'position')).toBe(
      'El valor no es válido.',
    );
  });

  it('un mensaje que no es el de la librería no se toca', () => {
    expect(translateConstraint('maxLength', 'Use hasta 20 números.', 'code')).toBe('Use hasta 20 números.');
  });

  it('los números del nombre del campo no se confunden con el límite', () => {
    expect(translateConstraint('maxLength', 'line2 must be shorter than or equal to 80 characters', 'line2')).toBe(
      'Escriba máximo 80 caracteres.',
    );
  });
});
