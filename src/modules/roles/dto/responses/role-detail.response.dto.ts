import { ApiProperty } from '@nestjs/swagger';
import { buildAccessProfile } from '../../../../common/authorization/build-access-profile.js';
import type { NavigationDefinition } from '../../../../common/authorization/navigation.registry.js';
import { NavigationItemResponseDto } from '../../../auth/dto/responses/navigation-item.response.dto.js';
import type { Role } from '../../../auth/entities/role.entity.js';
import type { Permission } from '../../entities/permission.entity.js';
import type { RoleSeparationOfDuties } from '../../entities/role-separation-of-duties.entity.js';
import { PermissionResponseDto } from './permission.response.dto.js';
import { RoleResponseDto } from './role.response.dto.js';
import { SodRuleResponseDto } from './sod-rule.response.dto.js';

export class RoleDetailResponseDto extends RoleResponseDto {
  @ApiProperty({ type: [PermissionResponseDto] })
  readonly permissions!: ReadonlyArray<PermissionResponseDto>;

  @ApiProperty({
    type: [NavigationItemResponseDto],
    description:
      'Menús que abre este set de permisos. No se asignan aparte; cambian al guardar la matriz.',
  })
  readonly navigation!: ReadonlyArray<NavigationItemResponseDto>;

  @ApiProperty({ type: [RoleResponseDto] })
  readonly children!: ReadonlyArray<RoleResponseDto>;

  @ApiProperty({ type: [SodRuleResponseDto] })
  readonly sodRules!: ReadonlyArray<SodRuleResponseDto>;

  static fromDetail(
    role: Role,
    permissions: ReadonlyArray<Permission>,
    children: ReadonlyArray<Role>,
    sodRules: ReadonlyArray<RoleSeparationOfDuties>,
    catalog: ReadonlyArray<NavigationDefinition> = [],
  ): RoleDetailResponseDto {
    const navigation = buildAccessProfile(
      permissions.map((permission) => ({
        code: permission.code,
        module: permission.module,
        resourceType: permission.resourceType,
        action: permission.action,
        scopeLevel: permission.scopeLevel,
      })),
      catalog,
    ).navigation;
    return {
      ...RoleResponseDto.from(role),
      permissions: permissions.map(PermissionResponseDto.from),
      navigation: navigation.map(NavigationItemResponseDto.from),
      children: children.map(RoleResponseDto.from),
      sodRules: sodRules.map(SodRuleResponseDto.from),
    };
  }
}
