import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

export class CreateLoanDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  readonly assets!: string[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly targetCostCenterId!: string;

  @ApiProperty()
  @IsDateString()
  readonly expectedReturnDate!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  readonly justification!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly contactPerson!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly deliveryNotes?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly targetLocationId?: string;
}

export class RejectLoanDto {
  @ApiProperty()
  @IsString()
  @MinLength(5)
  readonly reason!: string;
}

export class ReturnLoanDto {
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        assetId: { type: 'string', format: 'uuid' },
        condition: { type: 'string', enum: ['GOOD', 'DAMAGED', 'LOST'] },
      },
    },
  })
  @IsArray()
  @ArrayMinSize(1)
  readonly assetsReturned!: ReadonlyArray<{
    readonly assetId: string;
    readonly condition: 'GOOD' | 'DAMAGED' | 'LOST';
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class ExtendLoanDto {
  @ApiProperty()
  @IsDateString()
  readonly expectedReturnDate!: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  readonly reason!: string;
}

export class QueryLoansDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  readonly pageSize: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly sourceCostCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly targetCostCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly requestedBy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  readonly overdue?: string;
}
