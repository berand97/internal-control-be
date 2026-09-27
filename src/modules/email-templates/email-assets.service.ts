import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { API_GLOBAL_PREFIX } from '../../common/swagger/openapi-document.js';
import type { AppConfig } from '../../config/configuration.js';
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

export interface EmailAssetFile {
  readonly mime: EmailAssetMime;
  readonly sha256: string;
  readonly byteSize: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ruta pública (sin sesión) de una imagen, bajo el prefijo global de la API. */
export const EMAIL_ASSET_PUBLIC_PATH = 'public/email-assets';

/**
 * Imágenes de las plantillas de correo (tabla email_asset): subir (validar, re-codificar, deduplicar por sha256),
 * listar para el selector del editor, resolver para el render y servir sin sesión. Nunca se borran: los correos
 * enviados siguen apuntando a su URL.
 */
@Injectable()
export class EmailAssetsService {
  constructor(
    @InjectRepository(EmailAsset)
    private readonly assets: Repository<EmailAsset>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** URL absoluta y pública de la imagen: API_PUBLIC_URL + /api/v1/public/email-assets/:id. */
  url(id: string): string {
    const base = this.config.getOrThrow('apiPublicUrl', { infer: true }).replace(/\/+$/, '');
    return `${base}/${API_GLOBAL_PREFIX}/${EMAIL_ASSET_PUBLIC_PATH}/${id}`;
  }

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
    const inserted = (await this.assets.query(
      `INSERT INTO email_asset (mime, content, byte_size, width, height, sha256, original_name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sha256) DO NOTHING
       RETURNING id`,
      [
        processed.mime,
        processed.content,
        processed.content.length,
        processed.width,
        processed.height,
        sha256,
        sanitizeAssetName(file.originalname),
        actorId,
      ],
    )) as Array<{ id: string }>;
    const row = inserted[0]
      ? await this.assets.findOneByOrFail({ id: inserted[0].id })
      : await this.assets.findOneByOrFail({ sha256 });
    return EmailAssetResponseDto.from(row, this.url(row.id));
  }

  /** Las más recientes primero, para el selector del editor. */
  async list(limit: number): Promise<ReadonlyArray<EmailAssetResponseDto>> {
    const rows = await this.assets.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
    return rows.map((row) => EmailAssetResponseDto.from(row, this.url(row.id)));
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

  /** URL y tamaño de las imágenes del diseño, para el renderizador. */
  async lookup(ids: ReadonlyArray<string>): Promise<EmailAssetLookup> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.assets.find({ select: { id: true, width: true, height: true }, where: { id: In([...ids]) } });
    return new Map(rows.map((row) => [row.id.toLowerCase(), { url: this.url(row.id), width: row.width, height: row.height }]));
  }

  /** Metadatos para servir la imagen (sin los bytes: un 304 no los lee). null si el id no es un uuid o no existe. */
  async publicFile(id: string): Promise<EmailAssetFile | null> {
    if (!UUID.test(id)) {
      return null;
    }
    const row = await this.assets.findOne({ select: { id: true, mime: true, sha256: true, byteSize: true }, where: { id } });
    return row ? { mime: row.mime, sha256: row.sha256, byteSize: row.byteSize } : null;
  }

  async publicContent(id: string): Promise<Buffer | null> {
    const rows = (await this.assets.query(`SELECT content FROM email_asset WHERE id = $1`, [id])) as Array<{
      content: Buffer;
    }>;
    return rows[0]?.content ?? null;
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
