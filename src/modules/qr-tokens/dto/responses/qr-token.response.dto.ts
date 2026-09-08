import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OperationalStatus } from '../../../assets/enums/operational-status.enum.js';

export class QrPublicAssetDto {
  @ApiProperty()
  readonly internalCode!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty()
  readonly categoryName!: string;

  @ApiProperty()
  readonly costCenterName!: string;

  @ApiProperty({ nullable: true })
  readonly locationName!: string | null;

  @ApiProperty({ enum: OperationalStatus })
  readonly operationalStatus!: OperationalStatus;
}

export class QrTokenResponseDto {
  @ApiProperty()
  readonly token!: string;

  @ApiProperty()
  readonly tokenVersion!: number;

  @ApiPropertyOptional()
  readonly pngBase64?: string;

  @ApiPropertyOptional()
  readonly qrSignedAt?: Date | null;
}

export class QrVerifyPublicResponseDto {
  @ApiProperty()
  readonly tokenVersion!: number;

  @ApiProperty({ type: QrPublicAssetDto })
  readonly asset!: QrPublicAssetDto;
}

export class QrVerifyAuthResponseDto extends QrVerifyPublicResponseDto {
  @ApiProperty({ type: [Object] })
  readonly recentMovements!: ReadonlyArray<{
    readonly id: string;
    readonly movementType: string;
    readonly executedAt: Date;
    readonly reason: string | null;
  }>;

  @ApiProperty({ type: [Object] })
  readonly activeLoans!: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
  }>;
}

export class QrHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly tokenVersion!: number;

  @ApiProperty()
  readonly action!: string;

  @ApiProperty({ nullable: true })
  readonly performedBy!: string | null;

  @ApiProperty()
  readonly createdAt!: Date;
}
