import { ApiProperty } from '@nestjs/swagger';
import type { Building } from '../../../buildings/entities/building.entity.js';
import type { Campus } from '../../../campus/entities/campus.entity.js';
import type { Location } from '../../entities/location.entity.js';
import { LocationType } from '../../enums/location-type.enum.js';

export const locationFullPath = (
  campus: Campus,
  building: Building,
  location: Location,
): string => {
  const segments = [campus.name, building.name];
  if (location.floorNumber !== null) {
    segments.push(`Piso ${location.floorNumber}`);
  }
  segments.push(location.name);
  return segments.join(' / ');
};

export class LocationResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly buildingId!: string;

  @ApiProperty({ format: 'uuid' })
  readonly campusId!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: LocationType })
  readonly type!: LocationType;

  @ApiProperty({ nullable: true })
  readonly floor!: number | null;

  @ApiProperty({ nullable: true })
  readonly capacity!: number | null;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({
    example: 'Campus Medellín / Bloque A / Piso 2 / Oficina 205',
  })
  readonly fullPath!: string;

  static from(
    location: Location,
    building: Building,
    campus: Campus,
  ): LocationResponseDto {
    return {
      id: location.id,
      buildingId: location.buildingId,
      campusId: campus.id,
      code: location.code,
      name: location.name,
      type: location.locationType,
      floor: location.floorNumber,
      capacity: location.capacity,
      isActive: location.isActive,
      fullPath: locationFullPath(campus, building, location),
    };
  }
}
