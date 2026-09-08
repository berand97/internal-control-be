import { ApiProperty } from '@nestjs/swagger';
import type { Campus } from '../../entities/campus.entity.js';

export class CampusResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ nullable: true })
  readonly address!: string | null;

  @ApiProperty({ nullable: true })
  readonly city!: string | null;

  @ApiProperty({ nullable: true })
  readonly department!: string | null;

  @ApiProperty({ nullable: true })
  readonly country!: string | null;

  @ApiProperty()
  readonly isActive!: boolean;

  static from(campus: Campus): CampusResponseDto {
    return {
      id: campus.id,
      code: campus.code,
      name: campus.name,
      address: campus.address,
      city: campus.city,
      department: campus.department,
      country: campus.country,
      isActive: campus.isActive,
    };
  }
}
