import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class VerifyRecoveryCodeDto {
  @ApiProperty({
    description:
      'Código de recuperación de un solo uso entregado al enrolar (XXXX-XXXX-XXXX). Se aceptan minúsculas, sin guiones y con espacios.',
    example: '7K3M-Q9ZD-X2PA',
    minLength: 12,
    maxLength: 20,
  })
  @IsString()
  @Length(12, 20)
  readonly recoveryCode!: string;
}
