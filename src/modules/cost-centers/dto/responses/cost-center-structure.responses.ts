import { ApiProperty } from '@nestjs/swagger';
import { CostCenterHeadDto } from '../../../persons/dto/cost-center-head.dto.js';

/**
 * Respuestas de la estructura de centros de costo (CostCenterPlacementService): ubicación con historial, árbol a una
 * fecha, sugerencia de código y centros cuyo código no cuadra con su unidad. Solo documentan lo que el servicio
 * devuelve: cambiar un shape exige cambiar ambos.
 */

export const PLACEMENT_SOURCES = ['MANUAL', 'IMPORT', 'MIGRATION'] as const;
export type PlacementSource = (typeof PLACEMENT_SOURCES)[number];

export const HISTORY_EVENT_KINDS = ['PLACEMENT', 'HEAD'] as const;
export type HistoryEventKind = (typeof HISTORY_EVENT_KINDS)[number];

export const PREFIX_MISMATCH_REASONS = ['NO_UNIT', 'UNIT_WITHOUT_PREFIX', 'CODE_OUT_OF_RANGE'] as const;
export type PrefixMismatchReason = (typeof PREFIX_MISMATCH_REASONS)[number];

export const CODE_SUGGESTION_BASES = ['PARENT', 'UNIT'] as const;
export type CodeSuggestionBasis = (typeof CODE_SUGGESTION_BASES)[number];

export class CostCenterUnitRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Dígito(s) inicial(es) del rango de códigos de sus centros' })
  readonly codePrefix!: string | null;
}

export class CostCenterRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly externalCode!: string;

  @ApiProperty()
  readonly name!: string;
}

export class CostCenterPlacementDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly costCenterId!: string;

  @ApiProperty({ type: CostCenterUnitRefDto, nullable: true })
  readonly organizationalUnit!: CostCenterUnitRefDto | null;

  @ApiProperty({ type: CostCenterRefDto, nullable: true, description: 'Centro padre' })
  readonly parent!: CostCenterRefDto | null;

  @ApiProperty({ description: 'true: recibe movimientos; false: nodo agrupador' })
  readonly hasMovement!: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly validFrom!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'null: vigente' })
  readonly validUntil!: string | null;

  @ApiProperty()
  readonly isCurrent!: boolean;

  @ApiProperty()
  readonly reason!: string;

  @ApiProperty({ enum: PLACEMENT_SOURCES, enumName: 'CostCenterPlacementSource' })
  readonly source!: PlacementSource;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Importación que hizo el cambio' })
  readonly stagingImportId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Usuario que hizo el cambio' })
  readonly changedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien hizo el cambio (nombres y apellidos, o su usuario)' })
  readonly changedByName!: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly changedAt!: string;
}

export class CostCenterPlacementAtDto {
  @ApiProperty({ format: 'date-time', description: 'Instante resuelto (fin del día pedido, hora de Colombia)' })
  readonly at!: string;

  @ApiProperty({
    type: CostCenterPlacementDto,
    nullable: true,
    description: 'null: el centro aún no existía en esa fecha',
  })
  readonly placement!: CostCenterPlacementDto | null;
}

export class CostCenterHistoryEventDto {
  @ApiProperty({ enum: HISTORY_EVENT_KINDS, enumName: 'CostCenterHistoryEventKind' })
  readonly kind!: HistoryEventKind;

  @ApiProperty({ format: 'date-time' })
  readonly validFrom!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly validUntil!: string | null;

  @ApiProperty({ type: CostCenterPlacementDto, nullable: true, description: 'Solo en kind=PLACEMENT' })
  readonly placement!: CostCenterPlacementDto | null;

  @ApiProperty({ type: CostCenterHeadDto, nullable: true, description: 'Solo en kind=HEAD' })
  readonly head!: CostCenterHeadDto | null;
}

export class CostCenterHistoryDto {
  @ApiProperty({ type: CostCenterRefDto })
  readonly costCenter!: CostCenterRefDto;

  @ApiProperty({
    type: [CostCenterHistoryEventDto],
    description: 'Ubicaciones y jefaturas juntas, de la más reciente a la más antigua (por validFrom)',
  })
  readonly events!: ReadonlyArray<CostCenterHistoryEventDto>;
}

export class CostCenterTreeHeadDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty({ description: 'Nombres y apellidos' })
  readonly personName!: string;
}

export class CostCenterTreeNodeDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly externalCode!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ description: 'Estado actual (el historial no guarda la desactivación)' })
  readonly isActive!: boolean;

  @ApiProperty({ description: 'A la fecha pedida' })
  readonly hasMovement!: boolean;

  @ApiProperty({ type: CostCenterUnitRefDto, nullable: true, description: 'Unidad a la fecha pedida' })
  readonly organizationalUnit!: CostCenterUnitRefDto | null;

  @ApiProperty({ description: 'Activos no dados de baja que hoy apuntan directamente a este centro' })
  readonly directAssets!: number;

  @ApiProperty({ type: [CostCenterTreeHeadDto], description: 'Jefes vigentes a la fecha pedida' })
  readonly heads!: ReadonlyArray<CostCenterTreeHeadDto>;

  @ApiProperty({ type: () => [CostCenterTreeNodeDto] })
  readonly children!: ReadonlyArray<CostCenterTreeNodeDto>;
}

export class CostCenterTreeDto {
  @ApiProperty({ format: 'date-time', description: 'Instante resuelto' })
  readonly at!: string;

  @ApiProperty({ type: [CostCenterTreeNodeDto], description: 'Centros sin padre a esa fecha, por código' })
  readonly roots!: ReadonlyArray<CostCenterTreeNodeDto>;
}

export class CostCenterCodeSuggestionDto {
  @ApiProperty({ type: 'string', nullable: true, description: 'null si el rango está lleno' })
  readonly code!: string | null;

  @ApiProperty()
  readonly rangeFrom!: string;

  @ApiProperty()
  readonly rangeTo!: string;

  @ApiProperty({ enum: CODE_SUGGESTION_BASES, enumName: 'CostCenterCodeSuggestionBasis' })
  readonly basis!: CodeSuggestionBasis;

  @ApiProperty({
    type: 'boolean',
    nullable: true,
    description: 'Con unidad con prefijo: si el código sugerido empieza por él (null sin unidad con prefijo o sin código)',
  })
  readonly matchesUnitPrefix!: boolean | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly reason!: string | null;
}

export class CostCenterPrefixMismatchDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly externalCode!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({
    enum: PREFIX_MISMATCH_REASONS,
    enumName: 'CostCenterPrefixMismatchReason',
    description: 'NO_UNIT: sin unidad; UNIT_WITHOUT_PREFIX: su unidad no tiene prefijo; CODE_OUT_OF_RANGE: el código no empieza por el prefijo de su unidad',
  })
  readonly reason!: PrefixMismatchReason;

  @ApiProperty({ type: CostCenterUnitRefDto, nullable: true, description: 'Unidad vigente' })
  readonly organizationalUnit!: CostCenterUnitRefDto | null;

  @ApiProperty({
    type: CostCenterUnitRefDto,
    nullable: true,
    description: 'Unidad activa cuyo prefijo (el más largo) corresponde al código, si hay',
  })
  readonly expectedUnit!: CostCenterUnitRefDto | null;
}
