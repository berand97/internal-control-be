import { ApiProperty } from '@nestjs/swagger';
import type { OrganizationalUnit } from '../../entities/organizational-unit.entity.js';
import { OrgUnitType } from '../../enums/org-unit-type.enum.js';

export class OrganizationalUnitResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly parentId!: string | null;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: OrgUnitType })
  readonly type!: OrgUnitType;

  @ApiProperty()
  readonly hierarchyLevel!: number;

  @ApiProperty({ nullable: true })
  readonly hierarchyPath!: string | null;

  @ApiProperty()
  readonly isActive!: boolean;

  static from(unit: OrganizationalUnit): OrganizationalUnitResponseDto {
    return {
      id: unit.id,
      parentId: unit.parentId,
      code: unit.code,
      name: unit.name,
      type: unit.unitType,
      hierarchyLevel: unit.hierarchyLevel,
      hierarchyPath: unit.hierarchyPath,
      isActive: unit.isActive,
    };
  }
}
