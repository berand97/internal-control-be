import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AppConfig } from '../../../config/configuration.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import type { InventoryItemPhotoDto } from '../dto/inventory-metrics.responses.js';
import { InventoryItemPhoto } from '../entities/inventory-item-photo.entity.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { InventoryActorPolicy } from './inventory-actor-policy.service.js';

const MAX_PHOTOS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Injectable()
export class InventoryItemPhotosService {
  constructor(
    @InjectRepository(InventoryItemPhoto)
    private readonly photos: Repository<InventoryItemPhoto>,
    @InjectRepository(PhysicalInventoryItem)
    private readonly items: Repository<PhysicalInventoryItem>,
    @InjectRepository(PhysicalInventory)
    private readonly inventories: Repository<PhysicalInventory>,
    private readonly storage: StorageService,
    private readonly actorPolicy: InventoryActorPolicy,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly dataSource: DataSource,
  ) {}

  async list(inventoryId: string, itemId: string): Promise<InventoryItemPhotoDto[]> {
    await this.requireItem(inventoryId, itemId);
    const rows = await this.photos.find({ where: { itemId }, order: { takenAt: 'ASC' } });
    return rows.map((row) => this.toDto(inventoryId, row));
  }

  async listByInventory(inventoryId: string): Promise<Map<string, InventoryItemPhotoDto[]>> {
    const rows = (await this.dataSource.query(
      `SELECT p.*
       FROM inventory_item_photo p
       JOIN physical_inventory_item i ON i.id = p.item_id
       WHERE i.inventory_id = $1
       ORDER BY p.taken_at ASC`,
      [inventoryId],
    )) as Array<{
      id: string;
      item_id: string;
      storage_key: string;
      content_type: string;
      byte_size: number;
      taken_at: Date;
      created_by: string;
      created_at: Date;
    }>;
    const map = new Map<string, InventoryItemPhotoDto[]>();
    for (const row of rows) {
      const dto = this.toDto(inventoryId, {
        id: row.id,
        itemId: row.item_id,
        storageKey: row.storage_key,
        contentType: row.content_type,
        byteSize: row.byte_size,
        takenAt: row.taken_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
      });
      const list = map.get(row.item_id) ?? [];
      list.push(dto);
      map.set(row.item_id, list);
    }
    return map;
  }

  async upload(
    inventoryId: string,
    itemId: string,
    file: { buffer: Buffer; mimetype: string },
    actor: AuthenticatedUser,
  ): Promise<InventoryItemPhotoDto> {
    const { inventory, item } = await this.requireItem(inventoryId, itemId);
    if (inventory.status !== InventoryStatus.InProgress) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    await this.actorPolicy.assertCanOperate(inventory, actor);
    if (!ALLOWED.has(file.mimetype)) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Formato de imagen no permitido.', [
        { field: 'file', message: 'Use jpeg, png o webp.' },
      ]);
    }
    if (file.buffer.byteLength > MAX_BYTES) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La imagen supera 5 MB.', [
        { field: 'file', message: 'Máximo 5 MB.' },
      ]);
    }
    const count = await this.photos.count({ where: { itemId: item.id } });
    if (count >= MAX_PHOTOS) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Este ítem ya tiene 5 fotos.', [
        { field: 'file', message: 'Máximo 5 fotos por ítem.' },
      ]);
    }
    const id = randomUUID();
    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const key = `inventories/${inventoryId}/items/${itemId}/${id}.${ext}`;
    await this.storage.put({ key, body: file.buffer, contentType: file.mimetype });
    const saved = await this.photos.save(
      this.photos.create({
        id,
        itemId: item.id,
        storageKey: key,
        contentType: file.mimetype,
        byteSize: file.buffer.byteLength,
        takenAt: new Date(),
        createdBy: actor.id,
      }),
    );
    return this.toDto(inventoryId, saved);
  }

  async content(inventoryId: string, itemId: string, photoId: string): Promise<{ contentType: string; body: Buffer }> {
    await this.requireItem(inventoryId, itemId);
    const photo = await this.photos.findOne({ where: { id: photoId, itemId } });
    if (!photo) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return { contentType: photo.contentType, body: await this.storage.get(photo.storageKey) };
  }

  private toDto(inventoryId: string, row: InventoryItemPhoto): InventoryItemPhotoDto {
    const api = this.config.getOrThrow('apiPublicUrl', { infer: true }).replace(/\/$/, '');
    return {
      id: row.id,
      url: `${api}/api/v1/inventories/${inventoryId}/items/${row.itemId}/photos/${row.id}/content`,
      takenAt: row.takenAt.toISOString(),
    };
  }

  private async requireItem(inventoryId: string, itemId: string) {
    const inventory = await this.inventories.findOne({ where: { id: inventoryId } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const item = await this.items.findOne({ where: { id: itemId, inventoryId } });
    if (!item) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return { inventory, item };
  }
}
