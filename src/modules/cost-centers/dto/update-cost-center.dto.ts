import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateCostCenterDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly name?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo se acepta igual al vigente: la unidad se cambia con POST /cost-centers/{id}/placement (400 COST_CENTER_PLACEMENT_REQUIRED)',
  })
  @IsOptional()
  @IsUUID('4')
  readonly organizationalUnitId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo se acepta igual al vigente: el padre se cambia con POST /cost-centers/{id}/placement (400 COST_CENTER_PLACEMENT_REQUIRED)',
  })
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly acceptsAssets?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
