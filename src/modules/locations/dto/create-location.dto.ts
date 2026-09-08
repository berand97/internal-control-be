import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  LOCATION_TYPES,
  LocationType,
} from '../enums/location-type.enum.js';

export class CreateLocationDto {
  @ApiProperty({ example: 'A-205', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  readonly code!: string;

  @ApiProperty({ example: 'Oficina 205', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly name!: string;

  @ApiProperty({ enum: LOCATION_TYPES, example: LocationType.Office })
  @IsIn(LOCATION_TYPES)
  readonly type!: LocationType;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly floor?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly capacity?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
