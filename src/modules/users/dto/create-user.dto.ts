import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  INSTITUTIONAL_EMAIL_MESSAGE,
  INSTITUTIONAL_EMAIL_REGEX,
} from '../../../common/validation/password.constants.js';

export class CreateUserDto {
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

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Departamento. Obligatorio si no se envía centro de costo. Si ambos van, el centro debe pertenecer a esta unidad.',
  })
  @IsOptional()
  @IsUUID('4')
  readonly organizationalUnitId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Centro de costo. Si se omite el departamento, se toma el de este centro.',
  })
  @IsOptional()
  @IsUUID('4')
  readonly costCenterId?: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Rol con el que se invita al usuario',
  })
  @IsUUID('4')
  readonly roleId!: string;
}
