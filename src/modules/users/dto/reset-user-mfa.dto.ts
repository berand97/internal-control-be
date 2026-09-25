import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class ResetUserMfaDto {
  @ApiProperty({
    description:
      'Motivo del restablecimiento (queda en la bitácora). No escriba números de documento, códigos ni secretos.',
    example: 'Pérdida del celular reportada por mesa de ayuda, caso 2026-1432',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @Length(10, 500)
  @Matches(/\S.{8,}\S/s, { message: 'reason debe tener al menos 10 caracteres útiles' })
  readonly reason!: string;
}
