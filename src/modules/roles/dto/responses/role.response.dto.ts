import { ApiProperty } from '@nestjs/swagger';
import type { Role } from '../../../auth/entities/role.entity.js';

export class RoleResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ nullable: true })
  readonly description!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly parentRoleId!: string | null;

  @ApiProperty()
  readonly hierarchyLevel!: number;

  @ApiProperty()
  readonly isSystem!: boolean;

  @ApiProperty()
  readonly isAssignable!: boolean;

  @ApiProperty({ nullable: true })
  readonly maxConcurrentUsers!: number | null;

  static from(role: Role): RoleResponseDto {
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      parentRoleId: role.parentRoleId,
      hierarchyLevel: role.hierarchyLevel,
      isSystem: role.isSystem,
      isAssignable: role.isAssignable,
      maxConcurrentUsers: role.maxConcurrentUsers,
    };
  }
}
