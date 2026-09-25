import { ApiProperty } from '@nestjs/swagger';
import { LoginResponseDto } from './login-response.dto.js';

export class MfaSetupConfirmedResponseDto extends LoginResponseDto {
  @ApiProperty({
    description:
      'Códigos de recuperación de un solo uso generados al activar MFA. Se muestran solo en esta respuesta.',
    type: [String],
    example: ['7K3M-Q9ZD-X2PA', 'H4TR-0MWB-9C8E'],
    minItems: 10,
    maxItems: 10,
  })
  readonly recoveryCodes!: ReadonlyArray<string>;

  static withCodes(
    login: LoginResponseDto,
    recoveryCodes: ReadonlyArray<string>,
  ): MfaSetupConfirmedResponseDto {
    return { ...login, recoveryCodes };
  }
}
