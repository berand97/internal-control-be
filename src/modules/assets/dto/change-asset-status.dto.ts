import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import {
  OPERATIONAL_STATUSES,
  OperationalStatus,
} from '../enums/operational-status.enum.js';

export class ChangeAssetStatusDto {
  @ApiProperty({ enum: OPERATIONAL_STATUSES })
  @IsIn(OPERATIONAL_STATUSES)
  readonly operationalStatus!: OperationalStatus;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly reason!: string;
}
