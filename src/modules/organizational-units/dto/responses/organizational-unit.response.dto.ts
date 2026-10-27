import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { OrganizationalUnit } from '../../entities/organizational-unit.entity.js';
import {
  ORG_RELATION_TYPE_LABELS,
  ORG_UNIT_TYPE_DESCRIPTION,
  ORG_UNIT_TYPE_LABELS,
  ORG_UNIT_TYPES,
  OrgRelationType,
  OrgUnitType,
} from '../../enums/org-unit-type.enum.js';

export class OrganizationalUnitResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly parentId!: string | null;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: ORG_UNIT_TYPES, enumName: 'OrgUnitType', description: ORG_UNIT_TYPE_DESCRIPTION })
  readonly type!: OrgUnitType;

  @ApiProperty({ description: `Tipo en español: ${ORG_UNIT_TYPES.map((type) => ORG_UNIT_TYPE_LABELS[type]).join(', ')}` })
  readonly unitTypeLabel!: string;

  @ApiProperty({
    enum: OrgRelationType,
    enumName: 'OrgRelationType',
    description: 'Línea del organigrama hacia su padre: AUTHORITY (autoridad), ADVISORY (asesoría), COORDINATION',
  })
  readonly relationType!: OrgRelationType;

  @ApiProperty({ description: 'Línea en español (Autoridad, Asesoría, Coordinación)' })
  readonly relationTypeLabel!: string;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Centro de costo "propio" del cuadro, amarrado (por ejemplo unidad 25 → 2510 Decanatura). null si no tiene o está pendiente',
  })
  readonly headCostCenterId!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Código del centro propio (amarrado o pendiente). null si la unidad no tiene centro propio',
  })
  readonly headCostCenterCode!: string | null;

  @ApiProperty({
    description: 'true si el centro propio se escribió por código pero ese centro aún no existe (o está archivado): se amarra solo cuando se cree',
  })
  readonly headCostCenterPending!: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '#de9927',
    description: 'Color base propio de la rama (#rrggbb en minúsculas); null si no tiene (hereda el de su jefe)',
  })
  readonly color!: string | null;

  @ApiProperty()
  readonly hierarchyLevel!: number;

  @ApiProperty({ type: 'string', nullable: true })
  readonly hierarchyPath!: string | null;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Dígito(s) inicial(es) del rango de códigos de sus centros de costo',
  })
  readonly codePrefix!: string | null;

  static from(unit: OrganizationalUnit): OrganizationalUnitResponseDto {
    return {
      id: unit.id,
      parentId: unit.parentId,
      code: unit.code,
      name: unit.name,
      type: unit.unitType,
      unitTypeLabel: ORG_UNIT_TYPE_LABELS[unit.unitType] ?? unit.unitType,
      relationType: unit.relationType,
      relationTypeLabel: ORG_RELATION_TYPE_LABELS[unit.relationType] ?? unit.relationType,
      headCostCenterId: unit.headCostCenterId,
      headCostCenterCode: unit.headCostCenterCode,
      headCostCenterPending: unit.headCostCenterId === null && unit.headCostCenterCode !== null,
      color: unit.color,
      hierarchyLevel: unit.hierarchyLevel,
      hierarchyPath: unit.hierarchyPath,
      isActive: unit.isActive,
      codePrefix: unit.codePrefix,
    };
  }
}

export class OrganizationalUnitDetailResponseDto extends OrganizationalUnitResponseDto {
  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de la unidad de la que depende; null si es raíz' })
  readonly parentName!: string | null;
}

export const ORG_UNIT_WARNING_FIELDS = ['codePrefix', 'headCostCenterCode'] as const;
export type OrgUnitWarningField = (typeof ORG_UNIT_WARNING_FIELDS)[number];

export enum OrgUnitWarningCode {
  PrefixOutsideParent = 'ORG_UNIT_PREFIX_OUTSIDE_PARENT',
  HeadCenterPending = 'ORG_UNIT_HEAD_CENTER_PENDING',
}

export class OrgUnitWarningDetailDto {
  @ApiProperty({
    enum: ORG_UNIT_WARNING_FIELDS,
    enumName: 'OrgUnitWarningField',
    description: 'Campo del formulario al que se refiere la advertencia',
  })
  readonly field!: OrgUnitWarningField;

  @ApiProperty({
    enum: OrgUnitWarningCode,
    enumName: 'OrgUnitWarningCode',
    description:
      'ORG_UNIT_PREFIX_OUTSIDE_PARENT: el prefijo no empieza por el de su jefe (codePrefix). ORG_UNIT_HEAD_CENTER_PENDING: el centro propio aún no existe o está archivado y queda pendiente (headCostCenterCode).',
  })
  readonly code!: OrgUnitWarningCode;

  @ApiProperty({ description: 'El mismo texto que aparece en warnings' })
  readonly message!: string;
}

export class OrganizationalUnitSaveResponseDto extends OrganizationalUnitResponseDto {
  @ApiProperty({
    type: [String],
    description:
      'Advertencias en español llano; vacío si no hay ninguna. No impiden guardar. Son los mismos textos de warningDetails, en el mismo orden.',
    example: ['El centro 1510 aún no existe. Quedará como centro propio cuando lo creen.'],
  })
  readonly warnings!: ReadonlyArray<string>;

  @ApiProperty({
    type: [OrgUnitWarningDetailDto],
    description: 'Las mismas advertencias de warnings con el campo y un código estable, para mostrarlas junto al campo. Vacío si no hay ninguna.',
  })
  readonly warningDetails!: ReadonlyArray<OrgUnitWarningDetailDto>;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description:
      'Solo al reactivar (isActive de false a true): unidades hijas directas que siguen archivadas. Reactivar no reactiva hijas ni centros.',
  })
  readonly archivedChildUnits?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    description: 'Solo al reactivar (isActive de false a true): centros de costo de la unidad que siguen archivados.',
  })
  readonly archivedCostCenters?: number;
}
