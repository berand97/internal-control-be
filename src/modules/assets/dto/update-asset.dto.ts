import { ApiHideProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateAssetDto } from './create-asset.dto.js';

export class UpdateAssetDto extends PartialType(
  OmitType(CreateAssetDto, ['photoUrl', 'stagedPhotoToken', 'photoFileId', 'responsibleId'] as const),
) {
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Obsoleto. Para cambiar fotos use /assets/{id}/photos. Se acepta por ahora',
  })
  @IsOptional()
  @IsString()
  readonly photoUrl?: string;

  @ApiHideProperty()
  @Equals(undefined, { message: 'El responsable se cambia con un acta de entrega.' })
  readonly responsibleId?: never;

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
