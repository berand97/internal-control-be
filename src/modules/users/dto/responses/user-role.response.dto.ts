import { ApiProperty } from '@nestjs/swagger';
import type { UserRole } from '../../../auth/entities/user-role.entity.js';

export class UserRoleResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly roleId!: string;

  @ApiProperty()
  readonly roleCode!: string;

  @ApiProperty()
  readonly roleName!: string;

  @ApiProperty()
  readonly scopeType!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly scopeId!: string | null;

  @ApiProperty()
  readonly validFrom!: string;

  @ApiProperty({ nullable: true })
  readonly validUntil!: string | null;

  @ApiProperty()
  readonly isDelegated!: boolean;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly delegatedFromUserId!: string | null;

  static from(assignment: UserRole): UserRoleResponseDto {
    return {
      id: assignment.id,
      roleId: assignment.roleId,
      roleCode: assignment.role?.code ?? '',
      roleName: assignment.role?.name ?? '',
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId,
      validFrom: assignment.validFrom.toISOString(),
      validUntil: assignment.validUntil?.toISOString() ?? null,
      isDelegated: assignment.isDelegated,
      delegatedFromUserId: assignment.delegatedFromUserId,
    };
  }
}
