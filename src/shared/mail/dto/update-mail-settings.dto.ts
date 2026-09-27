import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
} from 'class-validator';
import { NO_CONTROL_CHARS } from '../mail-address.js';

export class UpdateMailSettingsDto {
  @ApiPropertyOptional({ example: 'smtp.office365.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  readonly host?: string;

  @ApiPropertyOptional({ example: 587 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  readonly port?: number;

  @ApiPropertyOptional({
    description: 'True para SMTPS (465). False para STARTTLS (587).',
  })
  @IsOptional()
  @IsBoolean()
  readonly secure?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  readonly username?: string;

  @ApiPropertyOptional({
    description: 'Vacío conserva la contraseña ya guardada',
  })
  @IsOptional()
  @IsString()
  readonly password?: string;

  @ApiPropertyOptional({
    example: 'Control Interno UNAC',
    description: 'Sin saltos de línea ni caracteres de control',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Matches(NO_CONTROL_CHARS, { message: 'fromName no admite saltos de línea ni caracteres de control' })
  readonly fromName?: string;

  @ApiPropertyOptional({ example: 'noreply@unac.edu.co' })
  @IsOptional()
  @IsEmail()
  readonly fromEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;
}

export class TestMailDto {
  @ApiPropertyOptional({
    example: 'admin@unac.edu.co',
    description: 'Destino de la prueba. Si se omite se usa el remitente.',
  })
  @IsOptional()
  @IsEmail()
  readonly to?: string;
}
