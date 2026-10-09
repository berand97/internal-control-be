import { ApiProperty } from '@nestjs/swagger';
import type { OrganizationalUnit } from '../../entities/organizational-unit.entity.js';
import {
  ORG_RELATION_TYPE_LABELS,
  ORG_UNIT_TYPE_LABELS,
  OrgRelationType,
  OrgUnitType,
} from '../../enums/org-unit-type.enum.js';

export class OrganizationalUnitTreeResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly parentId!: string | null;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: OrgUnitType, enumName: 'OrgUnitType' })
  readonly type!: OrgUnitType;

  @ApiProperty({ description: 'Tipo en español (Rectoría, Vicerrectoría, Facultad, …)' })
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
    description: 'Centro de costo «propio» del cuadro, amarrado (p. ej. unidad 25 → 2510 Decanatura). null si no tiene o está pendiente',
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

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '#de9927',
    description:
      'Color con el que se pinta la rama: el propio o, si no tiene, el del ancestro más cercano que tenga uno (aunque ese ancestro no venga en la respuesta). null si nadie en la cadena tiene color',
  })
  readonly effectiveColor!: string | null;

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

  @ApiProperty({ type: () => [OrganizationalUnitTreeResponseDto] })
  readonly children!: ReadonlyArray<OrganizationalUnitTreeResponseDto>;

  static from(
    unit: OrganizationalUnit,
    children: ReadonlyArray<OrganizationalUnitTreeResponseDto>,
    effectiveColor: string | null = unit.color,
  ): OrganizationalUnitTreeResponseDto {
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
      effectiveColor,
      hierarchyLevel: unit.hierarchyLevel,
      hierarchyPath: unit.hierarchyPath,
      isActive: unit.isActive,
      codePrefix: unit.codePrefix,
      children,
    };
  }
}
