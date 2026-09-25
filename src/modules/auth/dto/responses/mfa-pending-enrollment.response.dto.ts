import { ApiProperty } from '@nestjs/swagger';
import { MfaEnrollmentResponseDto } from './mfa-enrollment.response.dto.js';

export class MfaPendingEnrollmentResponseDto extends MfaEnrollmentResponseDto {
  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description:
      'Hasta cuándo se puede confirmar este secreto. Mientras no se confirme, el factor vigente (si lo hay) sigue siendo el único válido.',
  })
  readonly expiresAt!: string;

  static fromPending(
    enrollment: MfaEnrollmentResponseDto,
    expiresAt: Date,
  ): MfaPendingEnrollmentResponseDto {
    return { ...enrollment, expiresAt: expiresAt.toISOString() };
  }
}
