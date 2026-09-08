import { ApiProperty } from '@nestjs/swagger';
import type { CostCenter } from '../../entities/cost-center.entity.js';

export class CostCenterResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly externalCode!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly organizationalUnitId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly parentId!: string | null;

  @ApiProperty()
  readonly acceptsAssets!: boolean;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty()
  readonly syncSource!: string;

  @ApiProperty({ nullable: true })
  readonly lastSyncedAt!: Date | null;

  static from(center: CostCenter): CostCenterResponseDto {
    return {
      id: center.id,
      externalCode: center.externalCode,
      name: center.name,
      organizationalUnitId: center.organizationalUnitId,
      parentId: center.parentId,
      acceptsAssets: center.acceptsAssets,
      isActive: center.isActive,
      syncSource: center.syncSource,
      lastSyncedAt: center.lastSyncedAt,
    };
  }
}
