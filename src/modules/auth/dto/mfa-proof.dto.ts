import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Prueba de posesión del factor vigente: un TOTP del dispositivo actual o un código de recuperación (que queda
 * consumido). Basta uno; si llegan ambos se prueba primero el TOTP.
 */
export class MfaProofDto {
  @ApiPropertyOptional({
    description: 'Código TOTP de 6 dígitos del dispositivo actualmente enrolado',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code debe ser un TOTP de 6 dígitos' })
  readonly code?: string;

  @ApiPropertyOptional({
    description:
      'Código de recuperación de un solo uso (XXXX-XXXX-XXXX). Se aceptan minúsculas, sin guiones y con espacios.',
    example: '7K3M-Q9ZD-X2PA',
    minLength: 12,
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @Length(12, 20)
  readonly recoveryCode?: string;
}
