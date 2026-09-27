import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const EMAIL_ASSET_MIMES = ['image/png', 'image/jpeg'] as const;
export type EmailAssetMime = (typeof EMAIL_ASSET_MIMES)[number];

/**
 * Imagen subida desde el editor de plantillas de correo (migración 1767225820000). Los bytes NO están en la BD: van,
 * ya re-codificados (sin metadatos EXIF/GPS, máximo 1200 px de ancho), al bucket de imágenes del proveedor S3
 * (storage_settings.s3_public_assets_bucket) en `images/email/<uuid>.<png|jpg>` (antes de 1767225830000:
 * `email-assets/…`, que se conserva), y el correo los carga desde
 * `public_url`. No se borran desde la aplicación: los correos enviados siguen apuntando a ellas. sha256 (del
 * contenido guardado) es único: subir la misma imagen devuelve la existente.
 */
@Entity('email_asset')
export class EmailAsset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Clave del objeto: images/email/<uuid>.<png|jpg>, o email-assets/… en filas anteriores (sin el nombre original). */
  @Column({ name: 'storage_key', type: 'varchar', length: 200 })
  storageKey!: string;

  /** URL absoluta pública (URL base del bucket + clave) que va en el <img src> del correo. */
  @Column({ name: 'public_url', type: 'text' })
  publicUrl!: string;

  @Column({ name: 'mime', type: 'varchar', length: 20 })
  mime!: EmailAssetMime;

  @Column({ name: 'byte_size', type: 'int' })
  byteSize!: number;

  @Column({ name: 'width', type: 'int' })
  width!: number;

  @Column({ name: 'height', type: 'int' })
  height!: number;

  @Column({ name: 'sha256', type: 'char', length: 64 })
  sha256!: string;

  @Column({ name: 'original_name', type: 'varchar', length: 120 })
  originalName!: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
