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

  @ApiProperty({ format: 'uuid', nullable: true })
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
    description: 'Centro de costo «propio» del cuadro (p. ej. unidad 25 → 2510 Decanatura). Solo por Excel o PATCH',
  })
  readonly headCostCenterId!: string | null;

  @ApiProperty()
  readonly hierarchyLevel!: number;

  @ApiProperty({ nullable: true })
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
      hierarchyLevel: unit.hierarchyLevel,
      hierarchyPath: unit.hierarchyPath,
      isActive: unit.isActive,
      codePrefix: unit.codePrefix,
      children,
    };
  }
}
