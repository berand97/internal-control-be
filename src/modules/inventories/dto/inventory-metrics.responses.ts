import { ApiProperty } from '@nestjs/swagger';
import {
  ACT_BLOCKED_REASONS,
  CLOSE_CHECK_CODES,
  type ActBlockedReason,
  type CloseCheckCode,
} from '../domain/inventory-metrics.js';

export class InventoryCoverageMetricDto {
  @ApiProperty()
  readonly verified!: number;

  @ApiProperty()
  readonly expected!: number;

  @ApiProperty({ type: 'number', nullable: true })
  readonly percent!: number | null;

  @ApiProperty()
  readonly target!: number;

  @ApiProperty()
  readonly meetsTarget!: boolean;
}

export class InventoryLocationAccuracyMetricDto {
  @ApiProperty()
  readonly inPlace!: number;

  @ApiProperty()
  readonly misplaced!: number;

  @ApiProperty()
  readonly attended!: number;

  @ApiProperty({ type: 'number', nullable: true })
  readonly percent!: number | null;
}

export class InventoryMissingMetricDto {
  @ApiProperty()
  readonly count!: number;

  @ApiProperty()
  readonly bookValue!: number;

  @ApiProperty()
  readonly withoutCause!: number;

  @ApiProperty()
  readonly withoutPhoto!: number;

  @ApiProperty()
  readonly aboveMateriality!: number;
}

export class InventorySurplusMetricDto {
  @ApiProperty()
  readonly count!: number;

  @ApiProperty()
  readonly resolved!: number;

  @ApiProperty()
  readonly unresolved!: number;
}

export class InventoryMetricsResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly inventoryId!: string;

  @ApiProperty({ type: () => InventoryCoverageMetricDto })
  readonly coverage!: InventoryCoverageMetricDto;

  @ApiProperty({ type: () => InventoryLocationAccuracyMetricDto })
  readonly locationAccuracy!: InventoryLocationAccuracyMetricDto;

  @ApiProperty({ type: () => InventoryMissingMetricDto })
  readonly missing!: InventoryMissingMetricDto;

  @ApiProperty({ type: () => InventorySurplusMetricDto })
  readonly surplus!: InventorySurplusMetricDto;

  @ApiProperty()
  readonly onLoan!: number;

  @ApiProperty()
  readonly temporaryCode!: number;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly valuationDate!: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly generatedAt!: string;
}

export class InventoryProgressByLocationItemDto {
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly locationId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;

  @ApiProperty()
  readonly expected!: number;

  @ApiProperty()
  readonly verified!: number;

  @ApiProperty()
  readonly pending!: number;

  @ApiProperty()
  readonly misplaced!: number;

  @ApiProperty()
  readonly notFound!: number;

  @ApiProperty({
    nullable: true,
    description: 'v1: siempre null (aún no hay asignación por ubicación)',
    type: 'object',
    additionalProperties: true,
  })
  readonly assignedTo!: { readonly userId: string; readonly name: string } | null;
}

export class InventoryProgressByLocationResponseDto {
  @ApiProperty({ type: () => InventoryProgressByLocationItemDto, isArray: true })
  readonly items!: InventoryProgressByLocationItemDto[];
}

export class InventoryProgressByCostCenterItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly costCenterId!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty()
  readonly expected!: number;

  @ApiProperty()
  readonly verified!: number;

  @ApiProperty({ type: 'number', nullable: true })
  readonly percent!: number | null;

  @ApiProperty()
  readonly actReady!: boolean;

  @ApiProperty({ enum: ACT_BLOCKED_REASONS, enumName: 'ActBlockedReason', nullable: true })
  readonly actBlockedReason!: ActBlockedReason | null;

  @ApiProperty({ enum: ['PENDING', 'AGREED', 'OBJECTED'], nullable: true })
  readonly agreementStatus!: 'PENDING' | 'AGREED' | 'OBJECTED' | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly agreementRespondedAt!: string | null;
}

export class InventoryProgressByCostCenterResponseDto {
  @ApiProperty({ type: () => InventoryProgressByCostCenterItemDto, isArray: true })
  readonly items!: InventoryProgressByCostCenterItemDto[];
}

export class InventoryQueueItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly itemId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly assetCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly assetDescription!: string | null;

  @ApiProperty({ enum: ['PENDING'] })
  readonly status!: 'PENDING';

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly expectedLocationId!: string | null;
}

export class InventoryQueueResponseDto {
  @ApiProperty({ type: () => InventoryQueueItemDto, isArray: true })
  readonly items!: InventoryQueueItemDto[];

  @ApiProperty()
  readonly page!: number;

  @ApiProperty()
  readonly pageSize!: number;

  @ApiProperty()
  readonly total!: number;
}

export class InventoryActivityItemDto {
  @ApiProperty({ format: 'date-time' })
  readonly at!: string;

  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty()
  readonly userName!: string;

  @ApiProperty({ enum: ['VERIFIED', 'CORRECTED', 'VOIDED', 'SURPLUS_RESOLVED'] })
  readonly action!: 'VERIFIED' | 'CORRECTED' | 'VOIDED' | 'SURPLUS_RESOLVED';

  @ApiProperty({ type: 'string', nullable: true })
  readonly assetCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly result!: string | null;
}

export class InventoryActivityResponseDto {
  @ApiProperty({ type: () => InventoryActivityItemDto, isArray: true })
  readonly items!: InventoryActivityItemDto[];
}

export class InventorySessionItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty()
  readonly verifiedToday!: number;

  @ApiProperty()
  readonly verifiedTotal!: number;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly lastActivityAt!: string | null;
}

export class InventorySessionsResponseDto {
  @ApiProperty({ type: () => InventorySessionItemDto, isArray: true })
  readonly items!: InventorySessionItemDto[];
}

export class InventoryCloseCheckDto {
  @ApiProperty({ enum: CLOSE_CHECK_CODES, enumName: 'CloseCheckCode' })
  readonly code!: CloseCheckCode;

  @ApiProperty()
  readonly passed!: boolean;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  readonly detail!: Record<string, unknown> | null;
}

export class InventoryCloseReadinessResponseDto {
  @ApiProperty()
  readonly canClose!: boolean;

  @ApiProperty({ description: 'Solo verdadero si el actor tiene inventory:create:global' })
  readonly canCloseWithPending!: boolean;

  @ApiProperty({ type: () => InventoryCloseCheckDto, isArray: true })
  readonly checks!: InventoryCloseCheckDto[];
}

export class DashboardInventorySummaryDto {
  @ApiProperty()
  readonly open!: number;

  @ApiProperty({ type: 'number', nullable: true })
  readonly averageCoverage!: number | null;

  @ApiProperty()
  readonly openMissing!: number;

  @ApiProperty()
  readonly actsPendingSignature!: number;
}

export class InventoryItemPhotoDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly url!: string;

  @ApiProperty({ format: 'date-time' })
  readonly takenAt!: string;
}
