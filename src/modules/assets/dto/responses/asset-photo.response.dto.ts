import { ApiProperty } from '@nestjs/swagger';

export class AssetPhotoResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly assetId!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'id en la galería. null en fotos antiguas guardadas como URL.' })
  readonly fileId!: string | null;

  @ApiProperty()
  readonly isPrimary!: boolean;

  @ApiProperty({ type: 'string', nullable: true })
  readonly caption!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Cuándo se puso la foto en este activo' })
  readonly linkedAt!: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '/assets/6f1c…/photos/2a9d…/content',
    description: 'Ruta bajo /api/v1 que entrega la foto con el token de sesión. null en fotos antiguas.',
  })
  readonly contentUrl!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: '/assets/6f1c…/photos/2a9d…/thumbnail' })
  readonly thumbnailUrl!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'URL de una foto antigua registrada a mano' })
  readonly legacyUrl!: string | null;

  @ApiProperty({ type: 'string', nullable: true, enum: ['image/jpeg', 'image/png', 'image/webp'] })
  readonly contentType!: string | null;

  @ApiProperty({ type: 'integer', nullable: true })
  readonly byteSize!: number | null;

  @ApiProperty({ type: 'integer', nullable: true })
  readonly width!: number | null;

  @ApiProperty({ type: 'integer', nullable: true })
  readonly height!: number | null;
}

export class AssetPhotoLinkResponseDto {
  @ApiProperty({ type: AssetPhotoResponseDto })
  readonly photo!: AssetPhotoResponseDto;

  @ApiProperty({ type: [String], description: 'Códigos internos de otros activos que ya tienen esta foto' })
  readonly alsoLinkedTo!: ReadonlyArray<string>;

  @ApiProperty({ type: 'string', nullable: true, example: 'Esta foto también está en el activo UNAC-000123.' })
  readonly warning!: string | null;
}

export class AssetPhotoUnlinkResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'date-time' })
  readonly unlinkedAt!: string;
}

export class AssetPhotoGalleryItemDto {
  @ApiProperty({ format: 'uuid', description: 'photoFileId para POST /assets/:id/photos/link' })
  readonly id!: string;

  @ApiProperty({ example: '/asset-photos/2a9d…/thumbnail', description: 'Ruta bajo /api/v1' })
  readonly thumbnailUrl!: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'UNAC-000123' })
  readonly originAssetCode!: string | null;

  @ApiProperty({ type: [String], description: 'Activos visibles para el usuario que tienen la foto' })
  readonly linkedAssetCodes!: ReadonlyArray<string>;

  @ApiProperty({ format: 'uuid' })
  readonly costCenterId!: string;

  @ApiProperty({ example: '4310' })
  readonly costCenterCode!: string;

  @ApiProperty({ type: 'integer' })
  readonly uploadYear!: number;

  @ApiProperty({ format: 'date-time' })
  readonly uploadedAt!: string;

  @ApiProperty({ type: 'integer' })
  readonly width!: number;

  @ApiProperty({ type: 'integer' })
  readonly height!: number;
}

export class AssetPhotoGalleryResponseDto {
  @ApiProperty({ type: [AssetPhotoGalleryItemDto] })
  readonly items!: ReadonlyArray<AssetPhotoGalleryItemDto>;

  @ApiProperty({ type: 'integer' })
  readonly year!: number;

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

export class StagedAssetPhotoResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Se entrega al crear el activo. Vence a las 24 horas.' })
  readonly token!: string;

  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  readonly contentType!: string;

  @ApiProperty({ type: 'integer' })
  readonly byteSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly width!: number;

  @ApiProperty({ type: 'integer' })
  readonly height!: number;

  @ApiProperty({ format: 'date-time' })
  readonly expiresAt!: string;
}
