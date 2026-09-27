import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { StorageService } from '../../shared/storage/storage.service.js';
import {
  EMAIL_IMAGE_LIMITS,
  EmailImageRejectedError,
  processEmailImage,
  sanitizeAssetName,
} from './domain/email-image.js';
import type { EmailAssetLookup } from './domain/email-renderer.js';
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
 * Imágenes de las plantillas de correo (tabla email_asset): subir (validar por bytes mágicos, re-codificar,
 * deduplicar por sha256 y guardar en el bucket PÚBLICO del proveedor S3), listar para el selector del editor y
 * resolver para el render. El backend no sirve los bytes: el correo usa public_url. Nunca se borran: los correos
 * enviados siguen apuntando a ellas.
 */
@Injectable()
export class EmailAssetsService {
  private readonly logger = new Logger(EmailAssetsService.name);

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
      // Otra subida de la misma imagen ganó la carrera: se borra el objeto duplicado y se devuelve la existente.
      await this.storage.deletePublicAsset(key).catch(() => this.logger.warn(`No se pudo borrar ${key} (duplicado)`));
      return EmailAssetResponseDto.from(await this.assets.findOneByOrFail({ sha256 }));
    }
    return EmailAssetResponseDto.from(await this.assets.findOneByOrFail({ id }));
  }

  /** Las más recientes primero, para el selector del editor. */
  async list(limit: number): Promise<ReadonlyArray<EmailAssetResponseDto>> {
    const rows = await this.assets.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
    return rows.map((row) => EmailAssetResponseDto.from(row));
  }

  /** Ids (en minúsculas) que no existen en email_asset. */
  async missing(ids: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    if (ids.length === 0) {
      return [];
    }
    const found = await this.assets.find({ select: { id: true }, where: { id: In([...ids]) } });
    const existing = new Set(found.map((row) => row.id.toLowerCase()));
    return ids.filter((id) => !existing.has(id.toLowerCase()));
  }

  /** URL pública y tamaño de las imágenes del diseño, para el renderizador. */
  async lookup(ids: ReadonlyArray<string>): Promise<EmailAssetLookup> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.assets.find({
      select: { id: true, publicUrl: true, width: true, height: true },
      where: { id: In([...ids]) },
    });
    return new Map(rows.map((row) => [row.id.toLowerCase(), { url: row.publicUrl, width: row.width, height: row.height }]));
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
