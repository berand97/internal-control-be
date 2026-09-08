import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, Matches } from 'class-validator';
import {
  INSTITUTIONAL_EMAIL_MESSAGE,
  INSTITUTIONAL_EMAIL_REGEX,
} from '../../../common/validation/password.constants.js';

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Correo institucional de la cuenta',
    example: 'juliana.perez@unac.edu.co',
  })
  @IsEmail()
  @Matches(INSTITUTIONAL_EMAIL_REGEX, { message: INSTITUTIONAL_EMAIL_MESSAGE })
  readonly email!: string;
}
