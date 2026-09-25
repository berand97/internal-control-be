import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class QueryTimelineDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 50;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'asc: del más antiguo al más reciente' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  readonly order: 'asc' | 'desc' = 'asc';
}
