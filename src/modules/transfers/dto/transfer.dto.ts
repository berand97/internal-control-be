import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PHYSICAL_CONDITIONS, type PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { ApiSignerSubstitutions, type SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import { MAX_TRANSFER_ASSETS, TRANSFER_STATUSES, type TransferStatus } from '../domain/transfer.js';

// ---------- Traslados ----------

export class TransferItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  readonly assetId!: string;

  @ApiProperty({ format: 'uuid', description: 'Motivo del catálogo (GET /transfers/reasons, activo). Columna «Razón» del acta' })
  @IsUUID('all')
  readonly reasonId!: string;

  @ApiPropertyOptional({
    enum: PHYSICAL_CONDITIONS,
    enumName: 'PhysicalCondition',
    description: 'Estado del activo en el acta (columna «Estado»). Por defecto, la condición física registrada del activo',
  })
  @IsOptional()
  @IsIn(PHYSICAL_CONDITIONS)
  readonly physicalCondition?: PhysicalCondition;

  @ApiPropertyOptional({ description: 'Verificación física del activo (columna «Físico»: Sí/No)', default: false })
  @IsOptional()
  @IsBoolean()
  readonly physicallyVerified?: boolean;

  @ApiPropertyOptional({ description: 'Observación de la verificación física', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly verificationNote?: string;

  @ApiPropertyOptional({
    description: 'El activo tiene su numeración (placa) — columna «Numeración» del acta institucional: Sí/No',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  readonly numberingPresent?: boolean;

  @ApiPropertyOptional({ description: 'Observaciones del activo en el acta', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly observations?: string;
}

export class CreateTransferDto {
  @ApiProperty({
    type: [TransferItemInputDto],
    description: `Activos del traslado, en el orden del acta (1 a ${MAX_TRANSFER_ASSETS}); todos del mismo centro de origen`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRANSFER_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => TransferItemInputDto)
  readonly items!: TransferItemInputDto[];

  @ApiProperty({ format: 'uuid', description: 'Centro de costo que recibe; distinto del de origen, activo y que admite activos' })
  @IsUUID('all')
  readonly targetCostCenterId!: string;

  @ApiProperty({ format: 'uuid', description: 'Quien entrega (jefe o encargado del centro de origen): firma el turno ENTREGA' })
  @IsUUID('all')
  readonly requesterPersonId!: string;

  @ApiProperty({ format: 'uuid', description: 'Quien recibe en el centro de destino: firma el turno RECIBE' })
  @IsUUID('all')
  readonly ownerPersonId!: string;

  @ApiProperty({ description: 'Justificación del traslado', minLength: 3, maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  readonly justification!: string;
}

export class UpdateTransferItemsDto {
  @ApiProperty({ type: [TransferItemInputDto], description: 'Lista completa de activos (reemplaza la anterior)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRANSFER_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => TransferItemInputDto)
  readonly items!: TransferItemInputDto[];
}

export class GenerateTransferActDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Quién firma por Control Interno (GET /transfers/control-signers). Opcional si hay una sola persona elegible; obligatorio si hay varias',
  })
  @IsOptional()
  @IsUUID('all')
  readonly controlSignerPersonId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Quién firma por Contabilidad (GET /transfers/accounting-signers). Opcional si hay una sola persona elegible; obligatorio si hay varias',
  })
  @IsOptional()
  @IsUUID('all')
  readonly accountingSignerPersonId?: string;

  @ApiSignerSubstitutions()
  readonly signerSubstitutions?: SignerSubstitutionsInput;
}

export class CancelTransferDto {
  @ApiProperty({ description: 'Motivo: queda en el traslado y en el acta anulada', minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

export class QueryTransfersDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ enum: TRANSFER_STATUSES, enumName: 'TransferStatus' })
  @IsOptional()
  @IsIn(TRANSFER_STATUSES)
  readonly status?: TransferStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  readonly sourceCostCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  readonly targetCostCenterId?: string;
}

// ---------- Catálogo de motivos ----------

export class CreateTransferReasonDto {
  @ApiProperty({ description: 'Código estable en mayúsculas (A-Z, 0-9, _)', example: 'REUBICACION', maxLength: 40 })
  @Matches(/^[A-Z][A-Z0-9_]{0,39}$/)
  readonly code!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  readonly name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly description?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  readonly sortOrder?: number;
}

export class UpdateTransferReasonDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  readonly name?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;

  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  readonly sortOrder?: number;
}
