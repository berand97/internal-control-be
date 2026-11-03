import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return value;
};

const toTrimmed = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export class UploadAssetPhotoDto {
  @ApiPropertyOptional({ maxLength: 200, description: 'Texto corto que acompaña la foto' })
  @IsOptional()
  @Transform(toTrimmed)
  @IsString({ message: 'Escriba la descripción de la foto como texto.' })
  @MaxLength(200, { message: 'La descripción de la foto admite hasta 200 caracteres.' })
  readonly caption?: string;

  @ApiPropertyOptional({
    description: 'true la deja como foto principal. Si se omite, queda como principal solo cuando el activo no tiene una.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'Indique si la foto es la principal.' })
  readonly primary?: boolean;
}

export class LinkAssetPhotoDto {
  @ApiProperty({ format: 'uuid', description: 'id de la galería (GET /asset-photos)' })
  @IsUUID('4', { message: 'Elija una foto de la galería.' })
  readonly photoFileId!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean({ message: 'Indique si la foto es la principal.' })
  readonly primary?: boolean;
}

export class QueryAssetPhotoGalleryDto {
  @ApiPropertyOptional({ minimum: 2000, maximum: 2999, description: 'Año de subida (Bogotá). Por defecto el año en curso.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Escriba el año con cuatro cifras.' })
  @Min(2000, { message: 'Escriba un año desde 2000.' })
  @Max(2999, { message: 'Escriba un año válido.' })
  readonly year?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4', { message: 'Elija un centro de costo de la lista.' })
  readonly costCenterId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página debe ser un número.' })
  @Min(1, { message: 'La página debe ser 1 o mayor.' })
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página debe ser un número.' })
  @Min(1, { message: 'El tamaño de página debe ser 1 o mayor.' })
  @Max(100, { message: 'El tamaño de página admite hasta 100.' })
  readonly pageSize: number = 24;
}
