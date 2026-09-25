import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DynamicFieldType } from '../../../dynamic-fields/enums/dynamic-field-type.enum.js';
import { DepreciationMethod } from '../../../categories/enums/depreciation-method.enum.js';
import type { AssetIdentifier } from '../../entities/asset-identifier.entity.js';
import type { Asset } from '../../entities/asset.entity.js';
import { AssetIdentifierOrigin } from '../../enums/asset-identifier.enum.js';
import { DATA_QUALITY_FLAGS } from '../../enums/data-quality-flag.enum.js';
import { OperationalStatus } from '../../enums/operational-status.enum.js';
import { PhysicalCondition } from '../../enums/physical-condition.enum.js';

export class AssetCustomValueResponseDto {
  @ApiProperty()
  readonly fieldId!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({ enum: DynamicFieldType })
  readonly type!: DynamicFieldType;

  @ApiProperty({ nullable: true })
  readonly value!: unknown;
}

export class AssetMovementResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly movementType!: string;

  @ApiProperty({ nullable: true })
  readonly reason!: string | null;

  @ApiProperty({ nullable: true })
  readonly documentReference!: string | null;

  @ApiProperty()
  readonly executedAt!: Date;

  @ApiProperty({ nullable: true, enum: OperationalStatus })
  readonly fromOperationalStatus!: OperationalStatus | null;

  @ApiProperty({ nullable: true, enum: OperationalStatus })
  readonly toOperationalStatus!: OperationalStatus | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly fromLocationId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly toLocationId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly fromCostCenterId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly toCostCenterId!: string | null;
}

export class AssetIdentifierResponseDto {
  @ApiProperty({ example: 'LEGACY_CODE', description: 'LEGACY_CODE, VISIBLE_CODE, OPAQUE_ID o un tipo futuro' })
  readonly type!: string;

  @ApiProperty({ example: '08252' })
  readonly value!: string;

  @ApiProperty({ enum: AssetIdentifierOrigin })
  readonly origin!: AssetIdentifierOrigin;

  @ApiProperty({ format: 'date-time' })
  readonly validFrom!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  readonly validTo!: string | null;

  @ApiProperty()
  readonly current!: boolean;

  static from(identifier: AssetIdentifier): AssetIdentifierResponseDto {
    return {
      type: identifier.identifierType,
      value: identifier.value,
      origin: identifier.origin,
      validFrom: identifier.validFrom.toISOString(),
      validTo: identifier.validTo ? identifier.validTo.toISOString() : null,
      current: identifier.validTo === null,
    };
  }
}

export class AssetNamedRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class AssetResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly internalCode!: string;

  @ApiProperty({ nullable: true })
  readonly barcode!: string | null;

  @ApiProperty({ nullable: true })
  readonly serialNumber!: string | null;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ nullable: true })
  readonly model!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly categoryId!: string;

  @ApiProperty({ format: 'uuid' })
  readonly costCenterId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly locationId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly responsibleId!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly acquisitionTypeId!: string;

  @ApiProperty({ nullable: true })
  readonly acquisitionDate!: string | null;

  @ApiProperty({ nullable: true })
  readonly acquisitionDocument!: string | null;

  @ApiProperty()
  readonly acquisitionPrice!: number;

  @ApiProperty()
  readonly currency!: string;

  @ApiProperty({ enum: OperationalStatus })
  readonly operationalStatus!: OperationalStatus;

  @ApiProperty({ enum: PhysicalCondition, nullable: true, description: 'null: nadie ha verificado el estado físico' })
  readonly physicalCondition!: PhysicalCondition | null;

  @ApiProperty({ enum: DepreciationMethod })
  readonly depreciationMethod!: DepreciationMethod;

  @ApiProperty({ nullable: true })
  readonly usefulLifeYears!: number | null;

  @ApiProperty({ nullable: true })
  readonly notes!: string | null;

  @ApiProperty({ nullable: true })
  readonly writtenOffAt!: string | null;

  @ApiProperty({ nullable: true })
  readonly qrTokenVersion!: number;

  @ApiPropertyOptional({ type: AssetNamedRefDto })
  readonly category?: AssetNamedRefDto;

  @ApiPropertyOptional({ type: AssetNamedRefDto })
  readonly costCenter?: AssetNamedRefDto;

  @ApiPropertyOptional({ type: AssetNamedRefDto, nullable: true })
  readonly location?: AssetNamedRefDto | null;

  @ApiPropertyOptional({ type: [AssetCustomValueResponseDto] })
  readonly customValues?: ReadonlyArray<AssetCustomValueResponseDto>;

  @ApiProperty({ type: [AssetIdentifierResponseDto] })
  readonly identifiers!: ReadonlyArray<AssetIdentifierResponseDto>;

  @ApiProperty({ type: [String], enum: DATA_QUALITY_FLAGS })
  readonly dataQualityFlags!: ReadonlyArray<string>;

  @ApiPropertyOptional({ type: [AssetMovementResponseDto] })
  readonly movements?: ReadonlyArray<AssetMovementResponseDto>;

  @ApiPropertyOptional({ type: [Object] })
  readonly activeLoans?: ReadonlyArray<{ readonly id: string; readonly status: string }>;

  static from(
    asset: Asset,
    identifiers: ReadonlyArray<AssetIdentifier>,
    extras?: {
      readonly category?: AssetNamedRefDto;
      readonly costCenter?: AssetNamedRefDto;
      readonly location?: AssetNamedRefDto | null;
      readonly customValues?: ReadonlyArray<AssetCustomValueResponseDto>;
      readonly movements?: ReadonlyArray<AssetMovementResponseDto>;
      readonly activeLoans?: ReadonlyArray<{ readonly id: string; readonly status: string }>;
    },
  ): AssetResponseDto {
    return {
      id: asset.id,
      internalCode: asset.internalCode,
      barcode: asset.barcode,
      serialNumber: asset.serialNumber,
      description: asset.description,
      model: asset.model,
      categoryId: asset.categoryId,
      costCenterId: asset.costCenterId,
      locationId: asset.locationId,
      responsibleId: asset.responsibleId,
      acquisitionTypeId: asset.acquisitionTypeId,
      acquisitionDate: asset.acquisitionDate
        ? String(asset.acquisitionDate).slice(0, 10)
        : null,
      acquisitionDocument: asset.acquisitionDocument,
      acquisitionPrice: Number(asset.acquisitionPrice),
      currency: asset.currency,
      operationalStatus: asset.operationalStatus,
      physicalCondition: asset.physicalCondition,
      depreciationMethod: asset.depreciationMethod,
      usefulLifeYears: asset.usefulLifeYears,
      notes: asset.notes,
      writtenOffAt: asset.writtenOffAt
        ? String(asset.writtenOffAt).slice(0, 10)
        : null,
      qrTokenVersion: asset.qrTokenVersion,
      identifiers: identifiers
        .filter((identifier) => identifier.assetId === asset.id)
        .map((identifier) => AssetIdentifierResponseDto.from(identifier)),
      dataQualityFlags: asset.dataQualityFlags,
      ...(extras?.category ? { category: extras.category } : {}),
      ...(extras?.costCenter ? { costCenter: extras.costCenter } : {}),
      ...(extras && 'location' in extras ? { location: extras.location } : {}),
      ...(extras?.customValues ? { customValues: extras.customValues } : {}),
      ...(extras?.movements ? { movements: extras.movements } : {}),
      ...(extras?.activeLoans ? { activeLoans: extras.activeLoans } : {}),
    };
  }
}

export class AssetListResponseDto {
  @ApiProperty({ type: [AssetResponseDto] })
  readonly items!: ReadonlyArray<AssetResponseDto>;

  @ApiProperty()
  readonly page!: number;

  @ApiProperty()
  readonly pageSize!: number;

  @ApiProperty()
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

export class AcquisitionTypeResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class AssetImportErrorDto {
  @ApiProperty()
  readonly row!: number;

  @ApiProperty()
  readonly message!: string;

  @ApiProperty()
  readonly code!: string;
}

export class AssetImportPreviewResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly previewId!: string;

  @ApiProperty()
  readonly expiresAt!: Date;

  @ApiProperty()
  readonly total!: number;

  @ApiProperty()
  readonly validCount!: number;

  @ApiProperty()
  readonly errorCount!: number;

  @ApiProperty({ type: [AssetImportErrorDto] })
  readonly errors!: ReadonlyArray<AssetImportErrorDto>;
}

export class AssetBulkResultResponseDto {
  @ApiProperty()
  readonly createdCount!: number;

  @ApiProperty({ type: [AssetImportErrorDto] })
  readonly errors!: ReadonlyArray<AssetImportErrorDto>;

  @ApiProperty({ type: [AssetResponseDto] })
  readonly items!: ReadonlyArray<AssetResponseDto>;
}
