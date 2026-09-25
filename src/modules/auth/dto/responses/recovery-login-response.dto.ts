import { ApiProperty } from '@nestjs/swagger';
import { LoginResponseDto } from './login-response.dto.js';

export class RecoveryLoginResponseDto extends LoginResponseDto {
  @ApiProperty({
    description:
      'Códigos de recuperación que quedan sin usar tras consumir el presentado. Si es bajo, la UI debe invitar a regenerarlos o a re-enrolar el dispositivo.',
    example: 9,
  })
  readonly recoveryCodesRemaining!: number;

  static withRemaining(
    login: LoginResponseDto,
    recoveryCodesRemaining: number,
  ): RecoveryLoginResponseDto {
    return { ...login, recoveryCodesRemaining };
  }
}
