import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  INSTITUTIONAL_EMAIL_MESSAGE,
  INSTITUTIONAL_EMAIL_REGEX,
} from '../../../common/validation/password.constants.js';

const DOCUMENT_TYPES = ['CC', 'CE', 'TI', 'PAS'] as const;

export class CreateUserDto {
  @ApiProperty({ enum: DOCUMENT_TYPES, example: 'CC' })
  @IsIn(DOCUMENT_TYPES)
  readonly documentType!: (typeof DOCUMENT_TYPES)[number];

  @ApiProperty({ example: '1234567890', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  readonly documentNumber!: string;

  @ApiProperty({ example: 'Juliana', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  readonly firstName!: string;

  @ApiProperty({ example: 'Pérez', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  readonly lastName!: string;

  @ApiProperty({ example: 'juliana.perez@unac.edu.co' })
  @IsEmail()
  @Matches(INSTITUTIONAL_EMAIL_REGEX, { message: INSTITUTIONAL_EMAIL_MESSAGE })
  readonly email!: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  readonly phone?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  readonly positionTitle?: string;

  @ApiPropertyOptional({
    description:
      'Si se omite, el usuario de acceso es el correo institucional',
    example: 'juliana.perez@unac.edu.co',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  readonly username?: string;
}
