import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  MovementType,
} from '../../assets/enums/movement-type.enum.js';

const TYPES = [
  'REGISTRATION',
  'ASSIGNMENT',
  'LOAN',
  'RETURN',
  'TRANSFER',
  'RELOCATION',
  'MAINTENANCE_IN',
  'MAINTENANCE_OUT',
  'PHYSICAL_VERIFICATION',
  'CONDITION_CHANGE',
  'WRITE_OFF',
  'REACTIVATION',
  'QR_ROTATION',
  'CORRECTION',
] as const;

export class QueryMovementsDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ enum: TYPES })
  @IsOptional()
  @IsIn(TYPES)
  readonly type?: MovementType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  readonly fromDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  readonly toDate?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly performedBy?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly costCenterId?: string;
}
