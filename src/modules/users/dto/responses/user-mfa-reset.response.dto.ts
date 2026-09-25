import { ApiProperty } from '@nestjs/swagger';

export class UserMfaResetResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Usuario afectado' })
  readonly userId!: string;

  @ApiProperty({
    description: 'Sesiones (familias de refresh) revocadas del usuario afectado',
    example: 2,
  })
  readonly revokedSessions!: number;

  @ApiProperty({
    description: 'Códigos de recuperación eliminados (usados o no)',
    example: 10,
  })
  readonly recoveryCodesDeleted!: number;

  @ApiProperty({
    description:
      'Siempre true: el siguiente login del usuario pasa por el enrolamiento obligatorio de MFA',
    example: true,
  })
  readonly mfaEnrollmentRequired!: boolean;
}
