import { ApiProperty } from '@nestjs/swagger';

export class MfaChallengeResponseDto {
  @ApiProperty({
    description:
      'Token intermedio con scope mfa_challenge. Sólo es válido para POST /auth/mfa/verify.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  readonly mfaChallengeToken!: string;

  @ApiProperty({
    description: 'Indica que el login requiere un segundo factor',
    enum: [true],
  })
  readonly requiresMfa!: true;

  static from(mfaChallengeToken: string): MfaChallengeResponseDto {
    return { mfaChallengeToken, requiresMfa: true };
  }
}
