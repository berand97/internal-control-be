import { ApiProperty } from '@nestjs/swagger';
import type { RoleSeparationOfDuties } from '../../entities/role-separation-of-duties.entity.js';

export class SodRuleResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly roleAId!: string;

  @ApiProperty({ format: 'uuid' })
  readonly roleBId!: string;

  @ApiProperty()
  readonly constraintType!: string;

  @ApiProperty()
  readonly reason!: string;

  static from(rule: RoleSeparationOfDuties): SodRuleResponseDto {
    return {
      id: rule.id,
      roleAId: rule.roleAId,
      roleBId: rule.roleBId,
      constraintType: rule.constraintType,
      reason: rule.reason,
    };
  }
}
