import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { EMAIL_ASSET_MIMES, type EmailAssetMime, type EmailAsset } from '../entities/email-asset.entity.js';

export const EMAIL_ASSET_LIST_MAX = 100;

/** GET /email-templates/assets: las N más recientes (selector del editor). */
export class ListEmailAssetsQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: EMAIL_ASSET_LIST_MAX, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EMAIL_ASSET_LIST_MAX)
  readonly limit: number = 50;
}

export class EmailAssetResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Úselo como assetId del bloque image' })
  readonly id!: string;

  @ApiProperty({ enum: EMAIL_ASSET_MIMES, enumName: 'EmailAssetMime' })
  readonly mime!: EmailAssetMime;

  @ApiProperty({ type: 'integer', description: 'Ancho guardado en px (máximo 1200: se reduce al subir)' })
  readonly width!: number;

  @ApiProperty({ type: 'integer', description: 'Alto guardado en px' })
  readonly height!: number;

  @ApiProperty({ type: 'integer', description: 'Bytes guardados (re-codificada, sin metadatos)' })
  readonly byteSize!: number;

  @ApiProperty({ maxLength: 120, description: 'Nombre del archivo subido, saneado' })
  readonly originalName!: string;

  @ApiProperty({
    description:
      'URL pública absoluta del objeto (URL base + images/email/<uuid>.<png|jpg>; email-assets/… en imágenes anteriores); la usan los correos y la vista previa',
  })
  readonly url!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  static from(row: EmailAsset): EmailAssetResponseDto {
    return {
      id: row.id,
      mime: row.mime,
      width: row.width,
      height: row.height,
      byteSize: row.byteSize,
      originalName: row.originalName,
      url: row.publicUrl,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
