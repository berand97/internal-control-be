import { ApiProperty } from '@nestjs/swagger';

export class CostCenterSyncResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly filename!: string;

  @ApiProperty()
  readonly created!: number;

  @ApiProperty()
  readonly updated!: number;

  @ApiProperty()
  readonly deactivated!: number;

  @ApiProperty()
  readonly reactivated!: number;
}
