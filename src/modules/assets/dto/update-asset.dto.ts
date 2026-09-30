import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateAssetDto } from './create-asset.dto.js';

/**
 * Edición del activo (PATCH /assets/:id, asset:update:global). Todo campo que acepta se guarda o se rechaza con su
 * error; ninguno se descarta en silencio:
 * - internalCode y costCenterId: no cambian (406 ASSET_CANNOT_BE_MODIFIED; el centro, con un traslado firmado).
 * - acquisitionTypeId y acquisitionDate: no cambian (400 VALIDATION_FAILED si difieren): la fecha define el código
 *   interno y el inicio de la depreciación, y el tipo de adquisición la clasificación contable. Igual al actual, se acepta.
 * - acquisitionPrice: se corrige con motivo (priceChangeReason) cuando cambia; queda en la bitácora con el valor anterior
 *   y el nuevo, y en el historial del activo como movimiento CORRECTION.
 * - acquisitionDocument: se guarda. photoUrl: si es distinta de la foto principal, pasa a ser la foto principal (la
 *   anterior queda en el historial).
 */
export class UpdateAssetDto extends PartialType(CreateAssetDto) {
  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    example: 'Precio tomado de la factura FV-2019-0331',
    description:
      'Obligatorio cuando acquisitionPrice cambia el precio actual (400 VALIDATION_FAILED sin él). Queda como motivo del ' +
      'movimiento CORRECTION del historial; la bitácora guarda el precio anterior y el nuevo, no este texto. Sin cambio de precio se ignora',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3)
  @MaxLength(500)
  readonly priceChangeReason?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  readonly insurancePolicyNumber?: string;
}
