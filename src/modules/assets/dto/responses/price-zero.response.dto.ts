import { ApiProperty } from '@nestjs/swagger';
import { OPERATIONAL_STATUSES, OperationalStatus } from '../../enums/operational-status.enum.js';

export class PriceZeroReasonDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({ type: 'integer' })
  readonly sortOrder!: number;

  @ApiProperty({ description: 'Registrado en algún activo: no se puede borrar, solo desactivar' })
  readonly inUse!: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt!: string;
}

export class PriceZeroReasonDeletedDto {
  @ApiProperty({ example: true })
  readonly deleted!: boolean;
}

export class PriceZeroRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class PriceZeroReasonRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty()
  readonly isActive!: boolean;
}

export class PriceZeroClassifierDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ description: 'Nombre y apellidos' })
  readonly name!: string;
}

export class PriceZeroAssetDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ example: 'XLS-1234' })
  readonly internalCode!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly acquisitionDate!: string | null;

  @ApiProperty({ enum: OPERATIONAL_STATUSES, enumName: 'AssetOperationalStatus' })
  readonly operationalStatus!: OperationalStatus;

  @ApiProperty({ type: () => PriceZeroRefDto, nullable: true, description: 'Centro de costo actual' })
  readonly costCenter!: PriceZeroRefDto | null;

  @ApiProperty({ type: () => PriceZeroRefDto, nullable: true, description: 'Ubicación actual' })
  readonly location!: PriceZeroRefDto | null;

  @ApiProperty({ type: () => PriceZeroReasonRefDto, nullable: true, description: 'Motivo registrado; null: sin clasificar' })
  readonly reason!: PriceZeroReasonRefDto | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly note!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly classifiedAt!: string | null;

  @ApiProperty({ type: () => PriceZeroClassifierDto, nullable: true })
  readonly classifiedBy!: PriceZeroClassifierDto | null;
}

export class PriceZeroSummaryDto {
  @ApiProperty({ type: 'integer', description: 'Activos con precio cero (marca PRICE_ZERO) del alcance y del centro filtrado' })
  readonly total!: number;

  @ApiProperty({ type: 'integer' })
  readonly classified!: number;

  @ApiProperty({ type: 'integer' })
  readonly unclassified!: number;
}

export class PriceZeroAssetListDto {
  @ApiProperty({ type: () => PriceZeroAssetDto, isArray: true })
  readonly items!: PriceZeroAssetDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer', description: 'Filas con todos los filtros' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;

  @ApiProperty({ type: () => PriceZeroSummaryDto, description: 'Conteos sin los filtros classified, reasonId ni q' })
  readonly summary!: PriceZeroSummaryDto;
}
