import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { INVENTORY_SCOPE_TYPES, InventoryScopeType } from '../enums/inventory-scope.js';

export class QueryInventoryResponsibleCandidatesDto {
  @ApiPropertyOptional({ description: 'Busca en nombres, apellidos y usuario (sin distinguir mayúsculas)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly q?: string;

  @ApiPropertyOptional({
    enum: INVENTORY_SCOPE_TYPES,
    enumName: 'InventoryScopeType',
    description: 'Alcance de la toma que se programa: excluye a quien sería auditado por ella (jefe vigente de un centro auditado o custodio de un activo del alcance)',
  })
  @IsOptional()
  @IsIn(INVENTORY_SCOPE_TYPES)
  readonly scope?: InventoryScopeType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Requerido si scope no es GLOBAL' })
  @IsOptional()
  @IsUUID()
  readonly scopeId?: string;

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
}

export class InventoryResponsibleCandidateDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombres y apellidos de la persona; si no tiene persona, el usuario' })
  readonly name!: string;

  @ApiProperty()
  readonly username!: string;
}

export class InventoryCandidatesPaginationDto {
  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly totalItems!: number;

  @ApiProperty({ type: 'integer' })
  readonly totalPages!: number;
}

export class InventoryResponsibleCandidatesPageDto {
  @ApiProperty({ type: [InventoryResponsibleCandidateDto] })
  readonly items!: InventoryResponsibleCandidateDto[];

  @ApiProperty({ type: InventoryCandidatesPaginationDto })
  readonly pagination!: InventoryCandidatesPaginationDto;
}
