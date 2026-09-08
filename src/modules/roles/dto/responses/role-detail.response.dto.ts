import { ApiProperty } from '@nestjs/swagger';
import type { Role } from '../../../auth/entities/role.entity.js';
import type { Permission } from '../../entities/permission.entity.js';
import type { RoleSeparationOfDuties } from '../../entities/role-separation-of-duties.entity.js';
import { PermissionResponseDto } from './permission.response.dto.js';
import { RoleResponseDto } from './role.response.dto.js';
import { SodRuleResponseDto } from './sod-rule.response.dto.js';

export class RoleDetailResponseDto extends RoleResponseDto {
  @ApiProperty({ type: [PermissionResponseDto] })
  readonly permissions!: ReadonlyArray<PermissionResponseDto>;

  @ApiProperty({ type: [RoleResponseDto] })
  readonly children!: ReadonlyArray<RoleResponseDto>;

  @ApiProperty({ type: [SodRuleResponseDto] })
  readonly sodRules!: ReadonlyArray<SodRuleResponseDto>;

  static fromDetail(
    role: Role,
    permissions: ReadonlyArray<Permission>,
    children: ReadonlyArray<Role>,
    sodRules: ReadonlyArray<RoleSeparationOfDuties>,
  ): RoleDetailResponseDto {
    return {
      ...RoleResponseDto.from(role),
      permissions: permissions.map(PermissionResponseDto.from),
      children: children.map(RoleResponseDto.from),
      sodRules: sodRules.map(SodRuleResponseDto.from),
    };
  }
}
