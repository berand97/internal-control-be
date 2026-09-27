import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const EMAIL_ASSET_MIMES = ['image/png', 'image/jpeg'] as const;
export type EmailAssetMime = (typeof EMAIL_ASSET_MIMES)[number];

/**
 * Imagen subida desde el editor de plantillas de correo (migración 1767225820000). Se guarda ya re-codificada (sin
 * metadatos EXIF/GPS, máximo 1200 px de ancho) y se sirve sin sesión por GET /api/v1/public/email-assets/:id, porque
 * los clientes de correo necesitan una URL pública. No se borra desde la aplicación: los correos enviados siguen
 * apuntando a ella. sha256 (del contenido guardado) es único: subir la misma imagen devuelve la existente.
 */
@Entity('email_asset')
export class EmailAsset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'mime', type: 'varchar', length: 20 })
  mime!: EmailAssetMime;

  /** Bytes de la imagen. No se selecciona por defecto: solo el endpoint público la lee. */
  @Column({ name: 'content', type: 'bytea', select: false })
  content!: Buffer;

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
