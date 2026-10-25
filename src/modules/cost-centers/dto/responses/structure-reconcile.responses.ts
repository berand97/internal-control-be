import { ApiProperty } from '@nestjs/swagger';
import {
  CostCenterPrefixMismatchDto,
  CostCenterRefDto,
  CostCenterUnitRefDto,
} from './cost-center-structure.responses.js';

export const HEAD_LINK_KINDS = ['LINKED', 'RECODED'] as const;
export const HEAD_UNLINK_REASONS = ['ARCHIVED', 'MISSING'] as const;
export const MANUAL_EXCEPTION_REASONS = ['MANUAL', 'CYCLE'] as const;

export class StructureRelocationDto {
  @ApiProperty({ type: CostCenterRefDto })
  readonly center!: CostCenterRefDto;

  @ApiProperty({ type: CostCenterUnitRefDto, nullable: true, description: 'Unidad vigente' })
  readonly fromUnit!: CostCenterUnitRefDto | null;

  @ApiProperty({ type: CostCenterUnitRefDto, description: 'Unidad con el prefijo más largo que coincide con el código' })
  readonly toUnit!: CostCenterUnitRefDto;
}

export class StructureReparentDto {
  @ApiProperty({ type: CostCenterRefDto })
  readonly center!: CostCenterRefDto;

  @ApiProperty({ type: CostCenterRefDto, nullable: true })
  readonly fromParent!: CostCenterRefDto | null;

  @ApiProperty({ type: CostCenterRefDto, nullable: true, description: 'XYZ0 si existe; null: cuelga de su unidad' })
  readonly toParent!: CostCenterRefDto | null;
}

export class StructureHeadLinkDto {
  @ApiProperty({ type: CostCenterUnitRefDto })
  readonly unit!: CostCenterUnitRefDto;

  @ApiProperty({
    enum: HEAD_LINK_KINDS,
    enumName: 'StructureHeadLinkKind',
    description: 'LINKED: el centro propio pendiente ya existe y se amarra; RECODED: el centro amarrado cambió de código y la unidad lo sigue',
  })
  readonly kind!: (typeof HEAD_LINK_KINDS)[number];

  @ApiProperty({ description: 'Código que queda guardado' })
  readonly code!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Código guardado antes' })
  readonly previousCode!: string | null;

  @ApiProperty({ type: CostCenterRefDto })
  readonly center!: CostCenterRefDto;
}

export class StructureHeadUnlinkDto {
  @ApiProperty({ type: CostCenterUnitRefDto })
  readonly unit!: CostCenterUnitRefDto;

  @ApiProperty({
    enum: HEAD_UNLINK_REASONS,
    enumName: 'StructureHeadUnlinkReason',
    description: 'ARCHIVED: el centro propio se archivó; MISSING: ya no existe',
  })
  readonly reason!: (typeof HEAD_UNLINK_REASONS)[number];

  @ApiProperty({ type: 'string', nullable: true, description: 'Código que queda pendiente' })
  readonly code!: string | null;

  @ApiProperty({ type: CostCenterRefDto, nullable: true })
  readonly center!: CostCenterRefDto | null;
}

export class StructureManualExceptionDto {
  @ApiProperty({ type: CostCenterRefDto })
  readonly center!: CostCenterRefDto;

  @ApiProperty({
    enum: MANUAL_EXCEPTION_REASONS,
    enumName: 'StructureManualExceptionReason',
    description: 'MANUAL: ubicación fijada por una persona que no coincide con la regla; CYCLE: el padre por regla cerraría un ciclo',
  })
  readonly reason!: (typeof MANUAL_EXCEPTION_REASONS)[number];

  @ApiProperty({ type: CostCenterUnitRefDto, nullable: true })
  readonly currentUnit!: CostCenterUnitRefDto | null;

  @ApiProperty({ type: CostCenterUnitRefDto, nullable: true })
  readonly expectedUnit!: CostCenterUnitRefDto | null;

  @ApiProperty({ type: CostCenterRefDto, nullable: true })
  readonly currentParent!: CostCenterRefDto | null;

  @ApiProperty({ type: CostCenterRefDto, nullable: true })
  readonly expectedParent!: CostCenterRefDto | null;
}

export class StructureReconcileCountsDto {
  @ApiProperty()
  readonly relocations!: number;

  @ApiProperty()
  readonly reparents!: number;

  @ApiProperty()
  readonly headLinks!: number;

  @ApiProperty()
  readonly headUnlinks!: number;

  @ApiProperty({ description: 'Ubicaciones MANUAL (o con ciclo) que no se tocan' })
  readonly manualExceptions!: number;
}

export class StructureReconcilePreviewDto {
  @ApiProperty({ type: [StructureRelocationDto] })
  readonly relocations!: ReadonlyArray<StructureRelocationDto>;

  @ApiProperty({ type: [StructureReparentDto] })
  readonly reparents!: ReadonlyArray<StructureReparentDto>;

  @ApiProperty({ type: [StructureHeadLinkDto] })
  readonly headLinks!: ReadonlyArray<StructureHeadLinkDto>;

  @ApiProperty({ type: [StructureHeadUnlinkDto] })
  readonly headUnlinks!: ReadonlyArray<StructureHeadUnlinkDto>;

  @ApiProperty({ type: [StructureManualExceptionDto] })
  readonly manualExceptions!: ReadonlyArray<StructureManualExceptionDto>;

  @ApiProperty({ type: StructureReconcileCountsDto })
  readonly counts!: StructureReconcileCountsDto;

  @ApiProperty({ description: 'Huella de los cambios: enviarla como expectedHash en POST /organizational-units/reconcile' })
  readonly hash!: string;
}

export class StructureReconcileResultDto {
  @ApiProperty({ type: StructureReconcileCountsDto })
  readonly counts!: StructureReconcileCountsDto;

  @ApiProperty({ description: 'Huella del plan aplicado' })
  readonly hash!: string;
}

export class StructurePendingHeadDto {
  @ApiProperty({ format: 'uuid' })
  readonly unitId!: string;

  @ApiProperty()
  readonly unitName!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly prefix!: string | null;

  @ApiProperty({ description: 'Código del centro propio que aún no existe (o está archivado)' })
  readonly code!: string;
}

export class StructureCenterWithoutUnitDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class StructureUnitUnderArchivedParentDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly codePrefix!: string | null;

  @ApiProperty({ format: 'uuid', description: 'Unidad padre archivada' })
  readonly parentId!: string;

  @ApiProperty({ description: 'Nombre de la unidad padre archivada' })
  readonly parentName!: string;
}

export class StructureCenterInArchivedUnitDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código externo del centro' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ format: 'uuid', description: 'Unidad archivada a la que pertenece' })
  readonly unitId!: string;

  @ApiProperty({ description: 'Nombre de la unidad archivada' })
  readonly unitName!: string;
}

export class StructurePendingDto {
  @ApiProperty({ type: [StructurePendingHeadDto], description: 'Unidades con centro propio pendiente' })
  readonly pendingHeadCenters!: ReadonlyArray<StructurePendingHeadDto>;

  @ApiProperty({
    type: [StructureCenterWithoutUnitDto],
    description: 'Centros activos cuyo código no empieza por el prefijo de ninguna unidad activa',
  })
  readonly centersWithoutUnit!: ReadonlyArray<StructureCenterWithoutUnitDto>;

  @ApiProperty({ type: [CostCenterPrefixMismatchDto], description: 'Lo mismo que GET /cost-centers/prefix-mismatches' })
  readonly mismatches!: ReadonlyArray<CostCenterPrefixMismatchDto>;

  @ApiProperty({ type: [StructureManualExceptionDto] })
  readonly manualExceptions!: ReadonlyArray<StructureManualExceptionDto>;

  @ApiProperty({
    type: [StructureUnitUnderArchivedParentDto],
    description: 'Unidades activas cuyo padre está archivado (datos anteriores a la regla): reactive el padre o mueva la unidad',
  })
  readonly unitsUnderArchivedParent!: ReadonlyArray<StructureUnitUnderArchivedParentDto>;

  @ApiProperty({
    type: [StructureCenterInArchivedUnitDto],
    description: 'Centros activos cuya unidad está archivada (datos anteriores a la regla): reactive la unidad, reubique o archive el centro',
  })
  readonly centersInArchivedUnit!: ReadonlyArray<StructureCenterInArchivedUnitDto>;
}
