import { ApiProperty } from '@nestjs/swagger';
import type { Building } from '../../entities/building.entity.js';

export class BuildingResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly campusId!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ nullable: true })
  readonly floorsCount!: number | null;

  @ApiProperty()
  readonly isActive!: boolean;

  static from(building: Building): BuildingResponseDto {
    return {
      id: building.id,
      campusId: building.campusId,
      code: building.code,
      name: building.name,
      floorsCount: building.floorsCount,
      isActive: building.isActive,
    };
  }
}
