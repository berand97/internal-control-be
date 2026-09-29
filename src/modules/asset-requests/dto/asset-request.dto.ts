import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
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
import { ApiSignerSubstitutions, type SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import { TransferItemInputDto } from '../../transfers/dto/transfer.dto.js';
import { MAX_TRANSFER_ASSETS } from '../../transfers/domain/transfer.js';
import {
  ASSET_REQUEST_KINDS,
  ASSET_REQUEST_STATUSES,
  type AssetRequestKind,
  type AssetRequestStatus,
  REASON_MAX,
  REASON_MIN,
} from '../domain/asset-request.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ASSET_REQUEST_BOXES = ['mine', 'to-decide', 'review'] as const;
export type AssetRequestBox = (typeof ASSET_REQUEST_BOXES)[number];

export class CreateAssetRequestDto {
  @ApiProperty({ enum: ASSET_REQUEST_KINDS, enumName: 'AssetRequestKind', description: 'TEMPORARY = préstamo; PERMANENT = traslado' })
  @IsIn(ASSET_REQUEST_KINDS)
  readonly kind!: AssetRequestKind;

  @ApiProperty({ format: 'uuid', description: 'Centro que solicita (destino de los activos); quien solicita debe ser su jefe vigente' })
  @IsUUID('all')
  readonly requestingCostCenterId!: string;

  @ApiProperty({ format: 'uuid', description: 'Centro al que se le piden los activos; debe tener jefe vigente' })
  @IsUUID('all')
  readonly ownerCostCenterId!: string;

  @ApiProperty({ description: 'Qué necesita', minLength: 3, maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  readonly description!: string;

  @ApiPropertyOptional({
    description: 'Texto libre que ayuda al dueño (códigos, descripción). Nunca se valida ni se resuelve contra activos',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly note?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Obligatoria si kind = TEMPORARY' })
  @IsOptional()
  @Matches(DATE)
  readonly startDate?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Obligatoria si kind = TEMPORARY; no anterior a startDate' })
  @IsOptional()
  @Matches(DATE)
  readonly expectedReturnDate?: string;
}

export class CorrectAssetRequestDto {
  @ApiPropertyOptional({ enum: ASSET_REQUEST_KINDS, enumName: 'AssetRequestKind' })
  @IsOptional()
  @IsIn(ASSET_REQUEST_KINDS)
  readonly kind?: AssetRequestKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  readonly requestingCostCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  readonly ownerCostCenterId?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  readonly description?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 2000, description: 'null la borra' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly note?: string | null;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(DATE)
  readonly startDate?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(DATE)
  readonly expectedReturnDate?: string;
}

export class AcceptAssetRequestDto {
  @ApiProperty({ type: [String], format: 'uuid', description: `Activos del centro dueño (1 a ${MAX_TRANSFER_ASSETS})` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRANSFER_ASSETS)
  @IsUUID('all', { each: true })
  readonly assetIds!: string[];

  @ApiPropertyOptional({ description: 'Comentario del dueño al aceptar (queda en el historial)', maxLength: REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX)
  readonly note?: string;
}

export class AssetRequestReasonDto {
  @ApiProperty({ description: 'Motivo (queda en el historial)', minLength: REASON_MIN, maxLength: REASON_MAX })
  @IsString()
  @MinLength(REASON_MIN)
  @MaxLength(REASON_MAX)
  readonly reason!: string;
}

export class GenerateAssetRequestDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Quién firma por Control Interno (AUDITA en el OCI-01-65, CONTROL_INTERNO en el OCI-17-89), entre GET /documents/control-signers (misma lista que valida la generación: fuera de ella, 400 TRANSFER_SIGNER_NOT_ELIGIBLE). Opcional si hay una sola persona elegible',
  })
  @IsOptional()
  @IsUUID('all')
  readonly controlSignerPersonId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'PERMANENT: quién firma por Contabilidad (GET /transfers/accounting-signers). Opcional si hay una sola persona elegible',
  })
  @IsOptional()
  @IsUUID('all')
  readonly accountingSignerPersonId?: string;

  @ApiSignerSubstitutions()
  readonly signerSubstitutions?: SignerSubstitutionsInput;

  @ApiPropertyOptional({
    type: [TransferItemInputDto],
    description:
      'PERMANENT (obligatorio): datos del acta por activo (motivo, condición, verificación, numeración, observaciones); exactamente los activos aceptados',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TRANSFER_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => TransferItemInputDto)
  readonly items?: TransferItemInputDto[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'TEMPORARY: observación por activo en el acta OCI-01-65 ({ assetId: texto })',
  })
  @IsOptional()
  @IsObject()
  readonly assetNotes?: Record<string, string>;

  @ApiPropertyOptional({ format: 'uuid', description: 'TEMPORARY: ubicación de destino del préstamo' })
  @IsOptional()
  @IsUUID('all')
  readonly targetLocationId?: string;

  @ApiPropertyOptional({ description: 'Justificación del documento; por defecto, la descripción de la solicitud', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  readonly justification?: string;
}

export class QueryAssetRequestsDto {
  @ApiPropertyOptional({
    enum: ASSET_REQUEST_BOXES,
    enumName: 'AssetRequestBox',
    default: 'mine',
    description: 'mine = abiertas por mí; to-decide = de los centros que dirijo hoy; review = Control Interno (asset_request:review:global)',
  })
  @IsOptional()
  @IsIn(ASSET_REQUEST_BOXES)
  readonly box: AssetRequestBox = 'mine';

  @ApiPropertyOptional({ enum: ASSET_REQUEST_STATUSES, enumName: 'AssetRequestStatus' })
  @IsOptional()
  @IsIn(ASSET_REQUEST_STATUSES)
  readonly status?: AssetRequestStatus;

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
}

export class EligibleAssetsQueryDto {
  @ApiPropertyOptional({ description: 'Código (visible, heredado o interno), serie o descripción', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly q?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly limit: number = 50;
}

export class ResolveScanDto {
  @ApiProperty({ description: 'Token del QR de la etiqueta' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  readonly token!: string;
}

export class OwnerAvailabilityQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  readonly costCenterId!: string;
}
