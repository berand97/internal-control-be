import { ApiProperty } from '@nestjs/swagger';
import type { Permission } from '../../entities/permission.entity.js';

export class PermissionResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly module!: string;

  @ApiProperty()
  readonly resourceType!: string;

  @ApiProperty()
  readonly action!: string;

  @ApiProperty()
  readonly scopeLevel!: string;

  @ApiProperty({ nullable: true })
  readonly description!: string | null;

  static from(permission: Permission): PermissionResponseDto {
    return {
      id: permission.id,
      code: permission.code,
      module: permission.module,
      resourceType: permission.resourceType,
      action: permission.action,
      scopeLevel: permission.scopeLevel,
      description: permission.description,
    };
  }
}
