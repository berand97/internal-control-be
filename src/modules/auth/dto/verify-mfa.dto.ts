import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class VerifyMfaDto {
  @ApiProperty({
    description:
      'Código TOTP de 6 dígitos generado por la aplicación de autenticación',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @Matches(/^\d{6}$/, { message: 'code debe ser un TOTP de 6 dígitos' })
  readonly code!: string;
}
