import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateCostCenterDto {
  @ApiProperty({ example: '4330', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  readonly externalCode!: string;

  @ApiProperty({ example: 'Talento Humano', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly name!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly organizationalUnitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly acceptsAssets?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
