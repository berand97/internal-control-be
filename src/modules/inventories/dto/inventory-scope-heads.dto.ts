import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { INVENTORY_SCOPE_TYPES, InventoryScopeType } from '../enums/inventory-scope.js';

export class QueryInventoryScopeHeadsDto {
  @ApiProperty({
    enum: INVENTORY_SCOPE_TYPES,
    enumName: 'InventoryScopeType',
    description: 'Alcance de la toma que se programa',
  })
  @IsIn(INVENTORY_SCOPE_TYPES)
  readonly scope!: InventoryScopeType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Requerido si scope no es GLOBAL' })
  @IsOptional()
  @IsUUID()
  readonly scopeId?: string;
}

export class InventoryScopeHeadDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty({ description: 'Nombre del jefe vigente' })
  readonly name!: string;
}

export class InventoryScopeHeadsResponseDto {
  @ApiProperty({ type: [InventoryScopeHeadDto] })
  readonly items!: InventoryScopeHeadDto[];
}
