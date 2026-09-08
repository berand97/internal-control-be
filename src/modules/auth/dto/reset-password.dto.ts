import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_POLICY_REGEX,
} from '../../../common/validation/password.constants.js';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Token de un solo uso enviado al correo',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly token!: string;

  @ApiProperty({
    description: 'Nueva contraseña que cumple la política institucional',
    minLength: 12,
  })
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  @Matches(PASSWORD_POLICY_REGEX, { message: PASSWORD_POLICY_MESSAGE })
  readonly newPassword!: string;
}
