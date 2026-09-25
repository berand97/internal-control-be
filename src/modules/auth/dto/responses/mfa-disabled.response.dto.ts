import { ApiProperty } from '@nestjs/swagger';

export class MfaDisabledResponseDto {
  @ApiProperty({
    description: 'Otras sesiones del usuario revocadas (la actual sigue vigente, ya sin MFA)',
    example: 1,
  })
  readonly revokedSessions!: number;

  @ApiProperty({ description: 'Códigos de recuperación eliminados', example: 10 })
  readonly recoveryCodesDeleted!: number;
}
