import { ApiProperty } from '@nestjs/swagger';

export class MfaRecoveryCodesResponseDto {
  @ApiProperty({
    description:
      'Códigos de recuperación de un solo uso. Se muestran solo en esta respuesta: el servidor guarda únicamente su hash. Invalidan cualquier juego anterior.',
    type: [String],
    example: ['7K3M-Q9ZD-X2PA', 'H4TR-0MWB-9C8E'],
    minItems: 10,
    maxItems: 10,
  })
  readonly recoveryCodes!: ReadonlyArray<string>;

  @ApiProperty({
    description: 'Códigos sin usar tras esta operación',
    example: 10,
  })
  readonly recoveryCodesRemaining!: number;

  static from(codes: ReadonlyArray<string>): MfaRecoveryCodesResponseDto {
    return { recoveryCodes: codes, recoveryCodesRemaining: codes.length };
  }
}
