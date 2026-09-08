import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import {
  LOCATION_TYPES,
  LocationType,
} from '../enums/location-type.enum.js';

export class QueryLocationsDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly campusId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly buildingId?: string;

  @ApiPropertyOptional({ enum: LOCATION_TYPES })
  @IsOptional()
  @IsIn(LOCATION_TYPES)
  readonly type?: LocationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly q?: string;
}
