import { ApiProperty } from '@nestjs/swagger';

export class MfaSetupRequiredResponseDto {
  @ApiProperty({
    description:
      'Token intermedio con scope mfa_setup. Sólo es válido para POST /auth/mfa/setup y POST /auth/mfa/confirm.',
  })
  readonly mfaSetupToken!: string;

  @ApiProperty({ enum: [true] })
  readonly requiresMfaSetup!: true;

  static from(mfaSetupToken: string): MfaSetupRequiredResponseDto {
    return { mfaSetupToken, requiresMfaSetup: true };
  }
}
