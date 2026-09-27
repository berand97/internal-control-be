import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { EmailAssetLookup } from './domain/email-renderer.js';
import { EmailAssetResponseDto } from './dto/email-asset.responses.js';
import { EmailAsset } from './entities/email-asset.entity.js';

/**
 * Imágenes de las plantillas de correo (tabla email_asset), solo lectura: lista para el selector del editor,
 * existencia al guardar y previsualizar, y URL pública + tamaño para el render. La subida (que necesita el
 * almacenamiento) está en EmailAssetUploadsService, en su propio módulo: así MailModule → EmailTemplatesModule no
 * depende de StorageModule (que importa AuthModule, que importa MailModule).
 */
@Injectable()
export class EmailAssetsService {
  constructor(
    @InjectRepository(EmailAsset)
    private readonly assets: Repository<EmailAsset>,
  ) {}

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
}
