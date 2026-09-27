import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { StorageService } from '../../shared/storage/storage.service.js';
import {
  EMAIL_IMAGE_LIMITS,
  EmailImageRejectedError,
  processEmailImage,
  sanitizeAssetName,
} from './domain/email-image.js';
import { EmailAssetResponseDto } from './dto/email-asset.responses.js';
import { EmailAsset, type EmailAssetMime } from './entities/email-asset.entity.js';

export interface EmailAssetUpload {
  readonly originalname?: string;
  readonly buffer: Buffer;
}

/** Prefijo de las imágenes en el bucket público: es lo único que la política anónima deja leer. */
export const EMAIL_ASSET_KEY_PREFIX = 'email-assets';

/** Inmutables: la clave lleva un uuid nuevo por imagen y nunca se reescribe. */
export const EMAIL_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const EXTENSION: Record<EmailAssetMime, 'png' | 'jpg'> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Clave no adivinable y sin el nombre original: email-assets/<uuid>.<png|jpg>. */
export const emailAssetKey = (id: string, mime: EmailAssetMime): string =>
  `${EMAIL_ASSET_KEY_PREFIX}/${id}.${EXTENSION[mime]}`;

/**
 * Subida de imágenes de las plantillas de correo: valida por bytes mágicos, re-codifica (sin EXIF/GPS, ≤ 1200 px),
 * deduplica por sha256 y guarda los bytes en el bucket PÚBLICO del proveedor S3 (StorageService.putPublicAsset).
 * En la BD solo quedan clave, URL pública y metadatos. Sin bucket público configurado: 409
 * PUBLIC_ASSETS_NOT_CONFIGURED; nunca se guarda en otro sitio.
 */
@Injectable()
export class EmailAssetUploadsService {
  private readonly logger = new Logger(EmailAssetUploadsService.name);

  constructor(
    @InjectRepository(EmailAsset)
    private readonly assets: Repository<EmailAsset>,
    private readonly storage: StorageService,
  ) {}

  async upload(file: EmailAssetUpload, actorId: string): Promise<EmailAssetResponseDto> {
    let processed;
    try {
      processed = await processEmailImage(file.buffer);
    } catch (error) {
      if (error instanceof EmailImageRejectedError) {
        throw this.rejection(error);
      }
      throw error;
    }
    const sha256 = createHash('sha256').update(processed.content).digest('hex');
    const existing = await this.assets.findOneBy({ sha256 });
    if (existing) {
      return EmailAssetResponseDto.from(existing);
    }
    const id = randomUUID();
    const key = emailAssetKey(id, processed.mime);
    const stored = await this.storage.putPublicAsset({
      key,
      body: processed.content,
      contentType: processed.mime,
      cacheControl: EMAIL_ASSET_CACHE_CONTROL,
    });
    const inserted = (await this.assets.query(
      `INSERT INTO email_asset (id, storage_key, public_url, mime, byte_size, width, height, sha256, original_name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (sha256) DO NOTHING
       RETURNING id`,
      [
        id,
        stored.key,
        stored.publicUrl,
        processed.mime,
        processed.content.length,
        processed.width,
        processed.height,
        sha256,
        sanitizeAssetName(file.originalname),
        actorId,
      ],
    )) as Array<{ id: string }>;
    if (inserted.length === 0) {
      // Otra subida de la misma imagen ganó la carrera: se intenta borrar el objeto duplicado y se devuelve la existente.
      await this.storage
        .deletePublicAsset(key)
        .catch(() => this.logger.warn(`No se pudo borrar el objeto duplicado ${key}`));
      return EmailAssetResponseDto.from(await this.assets.findOneByOrFail({ sha256 }));
    }
    return EmailAssetResponseDto.from(await this.assets.findOneByOrFail({ id }));
  }

  private rejection(error: EmailImageRejectedError): ApiException {
    switch (error.reason) {
      case 'NOT_PNG_OR_JPEG':
        return new ApiException(ErrorCode.FileTypeNotAllowed, 'Solo se admiten imágenes PNG o JPEG');
      case 'TOO_LARGE_DIMENSIONS': {
        const max = EMAIL_IMAGE_LIMITS.maxInputDimension;
        return new ApiException(ErrorCode.EmailAssetInvalidImage, `La imagen supera ${max} × ${max} px`);
      }
      case 'UNREADABLE':
        return new ApiException(ErrorCode.EmailAssetInvalidImage, 'La imagen está dañada o no se puede leer');
    }
  }
}
