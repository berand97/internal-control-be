import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

const SCOPE_TYPES = ['GLOBAL', 'ORG_UNIT', 'COST_CENTER'] as const;

export class AssignUserRoleDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly roleId!: string;

  @ApiPropertyOptional({ enum: SCOPE_TYPES, default: 'GLOBAL' })
  @IsOptional()
  @IsIn(SCOPE_TYPES)
  readonly scopeType?: (typeof SCOPE_TYPES)[number];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Requerido si scopeType no es GLOBAL',
  })
  @IsOptional()
  @IsUUID('4')
  readonly scopeId?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601. Por defecto ahora.',
  })
  @IsOptional()
  @IsDateString()
  readonly startDate?: string;

  @ApiPropertyOptional({ description: 'ISO 8601. Null = sin vencimiento.' })
  @IsOptional()
  @IsDateString()
  readonly endDate?: string;
}
