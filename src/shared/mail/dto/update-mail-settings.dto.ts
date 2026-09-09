import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

  @ApiPropertyOptional({ example: 'Control Interno UNAC' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
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
