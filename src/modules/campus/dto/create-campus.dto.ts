import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateCampusDto {
  @ApiProperty({ example: 'MED', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'El código debe ser SCREAMING_SNAKE_CASE',
  })
  readonly code!: string;

  @ApiProperty({ example: 'Campus Medellín', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly address?: string;

  @ApiPropertyOptional({ example: 'Medellín' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly city?: string;

  @ApiPropertyOptional({ example: 'Antioquia' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly department?: string;

  @ApiPropertyOptional({ example: 'Colombia' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly country?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
