import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export const AUDIT_REASON_MIN = 3;
export const AUDIT_REASON_MAX = 500;

/**
 * Motivo obligatorio de un cambio auditado (3..500 caracteres tras recortar espacios). Queda en la bitácora: no
 * debe llevar números de documento, contraseñas, tokens ni otros secretos.
 */
export const AuditReason = (description: string): PropertyDecorator =>
  applyDecorators(
    ApiProperty({
      minLength: AUDIT_REASON_MIN,
      maxLength: AUDIT_REASON_MAX,
      description: `${description} Queda en la bitácora; no escriba números de documento ni secretos.`,
    }),
    IsString(),
    Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value)),
    Length(AUDIT_REASON_MIN, AUDIT_REASON_MAX),
  );
