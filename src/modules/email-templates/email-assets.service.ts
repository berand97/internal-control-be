import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { EmailAssetLookup } from './domain/email-renderer.js';
import { EmailAssetResponseDto } from './dto/email-asset.responses.js';
import { EmailAsset } from './entities/email-asset.entity.js';

@Injectable()
export class EmailAssetsService {
  constructor(
    @InjectRepository(EmailAsset)
    private readonly assets: Repository<EmailAsset>,
  ) {}

  async list(limit: number): Promise<ReadonlyArray<EmailAssetResponseDto>> {
    const rows = await this.assets.find({ order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
    return rows.map((row) => EmailAssetResponseDto.from(row));
  }

  async missing(ids: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    if (ids.length === 0) {
      return [];
    }
    const found = await this.assets.find({ select: { id: true }, where: { id: In([...ids]) } });
    const existing = new Set(found.map((row) => row.id.toLowerCase()));
    return ids.filter((id) => !existing.has(id.toLowerCase()));
  }

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
