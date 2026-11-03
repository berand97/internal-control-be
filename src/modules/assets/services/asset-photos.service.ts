import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { StorageDriver } from '../../../config/configuration.js';
import {
  DEFAULT_MAX_INPUT_PIXELS,
  IMAGE_EXTENSION,
  ImageRejectedError,
  type ImageMime,
  type ProcessedImage,
  processImage,
  webpThumbnail,
} from '../../../shared/images/image-processing.js';
import {
  assetPhotoKey,
  assetPhotoStagedKey,
  assetPhotoStem,
  assetPhotoThumbKey,
  nextPhotoSequence,
  storageYear,
} from '../../../shared/storage/storage-keys.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { costCenterFilter, type ReadableCostCenterScope } from '../../roles/services/cost-center-scope.js';
import type {
  AssetPhotoGalleryItemDto,
  AssetPhotoGalleryResponseDto,
  AssetPhotoLinkResponseDto,
  AssetPhotoResponseDto,
  AssetPhotoUnlinkResponseDto,
  StagedAssetPhotoResponseDto,
} from '../dto/responses/asset-photo.response.dto.js';

export const ASSET_PHOTO_LIMITS = {
  maxStoredSide: 2560,
  thumbnailSide: 320,
  stagedTtlHours: 24,
} as const;

const PHOTO_MIMES: ReadonlyArray<ImageMime> = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_KEY_ATTEMPTS = 5;
const ASSET_ENTITY = 'ASSET';
const STAGED_ENTITY = 'PHOTO_STAGED';

export type PhotoVariant = 'content' | 'thumbnail';

export interface PhotoUpload {
  readonly buffer: Buffer;
}

export interface PhotoUploadOptions {
  readonly caption?: string | undefined;
  readonly primary?: boolean | undefined;
}

export interface PhotoContent {
  readonly contentType: string;
  readonly etag: string;
  readonly fileName: string;
  read(): Promise<Buffer>;
}

export interface GalleryQuery {
  readonly year?: number;
  readonly costCenterId?: string;
  readonly page: number;
  readonly pageSize: number;
}

interface LockedAsset {
  readonly id: string;
  readonly internal_code: string;
  readonly cost_center_id: string;
  readonly cost_center_code: string;
}

interface PhotoRow {
  readonly id: string;
  readonly asset_id: string;
  readonly file_id: string | null;
  readonly file_url: string | null;
  readonly is_primary: boolean;
  readonly caption: string | null;
  readonly uploaded_at: Date;
  readonly content_type: string | null;
  readonly byte_size: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

interface StoredFileRow {
  readonly storage_driver: StorageDriver;
  readonly storage_key: string;
  readonly thumb_key: string;
  readonly sha256: string;
  readonly content_type: string;
}

interface StagedRow {
  readonly id: string;
  readonly storage_driver: StorageDriver;
  readonly storage_key: string;
  readonly sha256: string;
  readonly content_type: ImageMime;
  readonly width: number;
  readonly height: number;
}

interface GalleryRow {
  readonly id: string;
  readonly uploaded_at: Date;
  readonly upload_year: number;
  readonly width: number;
  readonly height: number;
  readonly cost_center_id: string;
  readonly cost_center_code: string;
  readonly origin_asset_code: string | null;
  readonly linked_asset_codes: string[] | null;
}

const PHOTO_SELECT = `
  SELECT ph.id, ph.asset_id, ph.file_id, ph.file_url, ph.is_primary, ph.caption, ph.uploaded_at,
         f.content_type, f.byte_size, f.width, f.height
  FROM asset_photo ph
  LEFT JOIN photo_file f ON f.id = ph.file_id
  WHERE ph.asset_id = $1 AND ph.unlinked_at IS NULL`;

const sha256Of = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

const photoPath = (assetId: string, photoId: string, variant: PhotoVariant): string =>
  `/assets/${assetId}/photos/${photoId}/${variant}`;

const toDto = (row: PhotoRow): AssetPhotoResponseDto => ({
  id: row.id,
  assetId: row.asset_id,
  fileId: row.file_id,
  isPrimary: row.is_primary,
  caption: row.caption,
  linkedAt: new Date(row.uploaded_at).toISOString(),
  contentUrl: row.file_id ? photoPath(row.asset_id, row.id, 'content') : null,
  thumbnailUrl: row.file_id ? photoPath(row.asset_id, row.id, 'thumbnail') : null,
  legacyUrl: row.file_id ? null : row.file_url,
  contentType: row.content_type,
  byteSize: row.byte_size,
  width: row.width,
  height: row.height,
});

const rejection = (error: ImageRejectedError): ApiException => {
  switch (error.reason) {
    case 'UNSUPPORTED_TYPE':
      return new ApiException(ErrorCode.FileTypeNotAllowed, 'Suba una foto JPG, PNG o WebP.');
    case 'TOO_MANY_PIXELS':
      return new ApiException(
        ErrorCode.AssetPhotoInvalidImage,
        `La foto pasa de ${DEFAULT_MAX_INPUT_PIXELS / 1_000_000} megapíxeles. Use una más pequeña.`,
      );
    case 'UNREADABLE':
      return new ApiException(ErrorCode.AssetPhotoInvalidImage, 'La foto está dañada.');
  }
};

const withImageErrors = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ImageRejectedError) {
      throw rejection(error);
    }
    throw error;
  }
};

const otherAssetsWarning = (codes: ReadonlyArray<string>): string | null => {
  if (codes.length === 0) {
    return null;
  }
  return codes.length === 1
    ? `Esta foto también está en el activo ${codes[0]}.`
    : `Esta foto también está en los activos ${codes.join(', ')}.`;
};

@Injectable()
export class AssetPhotosService {
  private readonly logger = new Logger(AssetPhotosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async upload(
    assetId: string,
    file: PhotoUpload | undefined,
    options: PhotoUploadOptions,
    actor: AuthenticatedUser,
  ): Promise<AssetPhotoResponseDto> {
    const processed = await this.process(file);
    const thumbnail = await withImageErrors(() => webpThumbnail(processed.content, ASSET_PHOTO_LIMITS.thumbnailSide));
    const photoId = await this.withKeyRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const asset = await this.lockAsset(manager, assetId);
        const fileId = await this.storeFile(manager, asset, processed, thumbnail, actor, new Date());
        const id = await this.attach(manager, asset.id, fileId, sha256Of(processed.content), actor, options);
        await this.audit(AuditAction.AssetPhotoUploaded, ASSET_ENTITY, asset.id, actor, { photoId: id, fileId }, manager);
        return id;
      }),
    );
    return this.photo(assetId, photoId);
  }

  async list(assetId: string, scope: ReadableCostCenterScope): Promise<ReadonlyArray<AssetPhotoResponseDto>> {
    await this.assertReadable(assetId, scope);
    const rows = (await this.dataSource.query(`${PHOTO_SELECT} ORDER BY ph.is_primary DESC, ph.uploaded_at, ph.id`, [
      assetId,
    ])) as PhotoRow[];
    return rows.map(toDto);
  }

  async content(
    assetId: string,
    photoId: string,
    variant: PhotoVariant,
    scope: ReadableCostCenterScope,
    actor: AuthenticatedUser,
  ): Promise<PhotoContent> {
    await this.assertReadable(assetId, scope);
    const [row] = (await this.dataSource.query(
      `SELECT f.id AS file_id, f.storage_driver, f.storage_key, f.thumb_key, f.sha256, f.content_type
       FROM asset_photo ph JOIN photo_file f ON f.id = ph.file_id
       WHERE ph.id = $1 AND ph.asset_id = $2 AND ph.unlinked_at IS NULL`,
      [photoId, assetId],
    )) as Array<StoredFileRow & { file_id: string }>;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (variant === 'content') {
      await this.audit(AuditAction.AssetPhotoViewed, ASSET_ENTITY, assetId, actor, { photoId, fileId: row.file_id });
    }
    return this.contentOf(row, variant);
  }

  async link(
    assetId: string,
    photoFileId: string,
    primary: boolean | undefined,
    actor: AuthenticatedUser,
  ): Promise<AssetPhotoLinkResponseDto> {
    const { photoId, otherCodes } = await this.dataSource.transaction(async (manager) => {
      const asset = await this.lockAsset(manager, assetId);
      const [file] = (await manager.query('SELECT id, sha256 FROM photo_file WHERE id = $1', [photoFileId])) as Array<{
        id: string;
        sha256: string;
      }>;
      if (!file) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      const links = (await manager.query(
        `SELECT ph.asset_id, a.internal_code FROM asset_photo ph JOIN asset a ON a.id = ph.asset_id
         WHERE ph.file_id = $1 AND ph.unlinked_at IS NULL ORDER BY a.internal_code`,
        [file.id],
      )) as Array<{ asset_id: string; internal_code: string }>;
      if (links.some((link) => link.asset_id === asset.id)) {
        throw new ApiException(ErrorCode.AssetPhotoAlreadyLinked);
      }
      const id = await this.attach(manager, asset.id, file.id, file.sha256, actor, { primary: primary ?? false });
      await this.audit(AuditAction.AssetPhotoLinked, ASSET_ENTITY, asset.id, actor, { photoId: id, fileId: file.id }, manager);
      return { photoId: id, otherCodes: links.map((link) => link.internal_code) };
    });
    return {
      photo: await this.photo(assetId, photoId),
      alsoLinkedTo: otherCodes,
      warning: otherAssetsWarning(otherCodes),
    };
  }

  async unlink(assetId: string, photoId: string, actor: AuthenticatedUser): Promise<AssetPhotoUnlinkResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const [row] = (await manager.query(
        `UPDATE asset_photo SET unlinked_at = NOW(), is_primary = FALSE
         WHERE id = $1 AND asset_id = $2 AND unlinked_at IS NULL
         RETURNING id, file_id, unlinked_at`,
        [photoId, assetId],
      )) as [Array<{ id: string; file_id: string | null; unlinked_at: Date }>, number];
      const updated = Array.isArray(row) ? row[0] : undefined;
      if (!updated) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      await this.audit(
        AuditAction.AssetPhotoUnlinked,
        ASSET_ENTITY,
        assetId,
        actor,
        { photoId, fileId: updated.file_id },
        manager,
      );
      return { id: updated.id, unlinkedAt: new Date(updated.unlinked_at).toISOString() };
    });
  }

  async setPrimary(assetId: string, photoId: string, actor: AuthenticatedUser): Promise<AssetPhotoResponseDto> {
    await this.dataSource.transaction(async (manager) => {
      const asset = await this.lockAsset(manager, assetId);
      const [photo] = (await manager.query(
        'SELECT id, is_primary FROM asset_photo WHERE id = $1 AND asset_id = $2 AND unlinked_at IS NULL',
        [photoId, asset.id],
      )) as Array<{ id: string; is_primary: boolean }>;
      if (!photo) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (photo.is_primary) {
        return;
      }
      await manager.query('UPDATE asset_photo SET is_primary = FALSE WHERE asset_id = $1 AND is_primary', [asset.id]);
      await manager.query('UPDATE asset_photo SET is_primary = TRUE WHERE id = $1', [photo.id]);
      await this.clearPhotoMissing(manager, asset.id);
      await this.audit(AuditAction.AssetPhotoPrimarySet, ASSET_ENTITY, asset.id, actor, { photoId }, manager);
    });
    return this.photo(assetId, photoId);
  }

  async gallery(query: GalleryQuery, scope: ReadableCostCenterScope): Promise<AssetPhotoGalleryResponseDto> {
    const year = query.year ?? Number(storageYear(new Date()));
    const centers = costCenterFilter(scope);
    const params = [year, query.costCenterId ?? null, centers];
    const where = `f.upload_year = $1
      AND ($2::uuid IS NULL OR f.cost_center_id = $2::uuid)
      AND ($3::uuid[] IS NULL OR f.cost_center_id = ANY($3::uuid[]))`;
    const [counted] = (await this.dataSource.query(
      `SELECT count(*)::int AS total FROM photo_file f WHERE ${where}`,
      params,
    )) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `SELECT f.id, f.uploaded_at, f.upload_year, f.width, f.height, f.cost_center_id,
              cc.external_code AS cost_center_code, origin.internal_code AS origin_asset_code,
              (SELECT array_agg(a.internal_code ORDER BY a.internal_code)
                 FROM asset_photo ph JOIN asset a ON a.id = ph.asset_id
                WHERE ph.file_id = f.id AND ph.unlinked_at IS NULL
                  AND ($3::uuid[] IS NULL OR a.current_cost_center_id = ANY($3::uuid[]))) AS linked_asset_codes
       FROM photo_file f
       JOIN cost_center cc ON cc.id = f.cost_center_id
       LEFT JOIN asset origin ON origin.id = f.origin_asset_id
       WHERE ${where}
       ORDER BY f.uploaded_at DESC, f.id DESC
       LIMIT $4 OFFSET $5`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as GalleryRow[];
    const total = counted?.total ?? 0;
    return {
      items: rows.map(
        (row): AssetPhotoGalleryItemDto => ({
          id: row.id,
          thumbnailUrl: `/asset-photos/${row.id}/thumbnail`,
          originAssetCode: row.origin_asset_code,
          linkedAssetCodes: row.linked_asset_codes ?? [],
          costCenterId: row.cost_center_id,
          costCenterCode: row.cost_center_code,
          uploadYear: Number(row.upload_year),
          uploadedAt: new Date(row.uploaded_at).toISOString(),
          width: row.width,
          height: row.height,
        }),
      ),
      year,
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasNext: query.page * query.pageSize < total,
    };
  }

  async galleryThumbnail(fileId: string, scope: ReadableCostCenterScope): Promise<PhotoContent> {
    const [row] = (await this.dataSource.query(
      `SELECT f.storage_driver, f.storage_key, f.thumb_key, f.sha256, f.content_type
       FROM photo_file f
       WHERE f.id = $1
         AND ($2::uuid[] IS NULL OR f.cost_center_id = ANY($2::uuid[]) OR EXISTS (
           SELECT 1 FROM asset_photo ph JOIN asset a ON a.id = ph.asset_id
           WHERE ph.file_id = f.id AND ph.unlinked_at IS NULL AND a.current_cost_center_id = ANY($2::uuid[])))`,
      [fileId, costCenterFilter(scope)],
    )) as StoredFileRow[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.contentOf(row, 'thumbnail');
  }

  async stage(file: PhotoUpload | undefined, actor: AuthenticatedUser): Promise<StagedAssetPhotoResponseDto> {
    const processed = await this.process(file);
    const id = randomUUID();
    const stored = await this.storage.put({
      key: assetPhotoStagedKey(id),
      body: processed.content,
      contentType: processed.mime,
    });
    const [row] = (await this.dataSource.query(
      `INSERT INTO photo_staged_upload (id, storage_driver, storage_key, sha256, content_type, byte_size, width, height, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING uploaded_at`,
      [
        id,
        stored.driver,
        stored.key,
        sha256Of(processed.content),
        processed.mime,
        processed.content.length,
        processed.width,
        processed.height,
        actor.id,
      ],
    )) as Array<{ uploaded_at: Date }>;
    await this.audit(AuditAction.AssetPhotoStaged, STAGED_ENTITY, id, actor, {});
    const uploadedAt = new Date(row?.uploaded_at ?? Date.now());
    return {
      token: id,
      contentType: processed.mime,
      byteSize: processed.content.length,
      width: processed.width,
      height: processed.height,
      expiresAt: new Date(uploadedAt.getTime() + ASSET_PHOTO_LIMITS.stagedTtlHours * 3_600_000).toISOString(),
    };
  }

  async finalizeStaged(
    token: string,
    assetId: string,
    actor: AuthenticatedUser,
    options: PhotoUploadOptions = {},
    outer?: EntityManager,
  ): Promise<AssetPhotoResponseDto> {
    const run = async (manager: EntityManager): Promise<{ photoId: string; staged: StagedRow }> => {
      const [staged] = (await manager.query(
        `SELECT id, storage_driver, storage_key, sha256, content_type, width, height
         FROM photo_staged_upload
         WHERE id = $1 AND uploaded_by = $2 AND finalized_at IS NULL
           AND uploaded_at > NOW() - make_interval(hours => $3)
         FOR UPDATE`,
        [token, actor.id, ASSET_PHOTO_LIMITS.stagedTtlHours],
      )) as StagedRow[];
      if (!staged) {
        throw new ApiException(ErrorCode.AssetPhotoStagedNotFound);
      }
      const content = await this.storage.getFrom(staged.storage_driver, staged.storage_key);
      const processed: ProcessedImage = {
        mime: staged.content_type,
        content,
        width: staged.width,
        height: staged.height,
      };
      const thumbnail = await withImageErrors(() => webpThumbnail(content, ASSET_PHOTO_LIMITS.thumbnailSide));
      const asset = await this.lockAsset(manager, assetId);
      const fileId = await this.storeFile(manager, asset, processed, thumbnail, actor, new Date());
      const photoId = await this.attach(manager, asset.id, fileId, staged.sha256, actor, options);
      await manager.query('UPDATE photo_staged_upload SET finalized_at = NOW() WHERE id = $1', [staged.id]);
      await this.audit(
        AuditAction.AssetPhotoUploaded,
        ASSET_ENTITY,
        asset.id,
        actor,
        { photoId, fileId, staged: true },
        manager,
      );
      return { photoId, staged };
    };
    if (outer) {
      const { photoId } = await run(outer);
      return this.photo(assetId, photoId, outer);
    }
    const { photoId, staged } = await this.withKeyRetry(() => this.dataSource.transaction(run));
    await this.removeStaged(staged);
    return this.photo(assetId, photoId);
  }

  async purgeStaged(olderThan: Date): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT id, storage_driver, storage_key, sha256, content_type, width, height
       FROM photo_staged_upload
       WHERE finalized_at IS NOT NULL OR uploaded_at < $1
       ORDER BY uploaded_at
       LIMIT 1000`,
      [olderThan],
    )) as StagedRow[];
    let removed = 0;
    for (const row of rows) {
      if (await this.removeStaged(row)) {
        removed += 1;
      }
    }
    return removed;
  }

  private async removeStaged(row: StagedRow): Promise<boolean> {
    try {
      await this.storage.deleteFrom(row.storage_driver, row.storage_key);
    } catch (error) {
      this.logger.warn(
        `No se pudo borrar la foto pendiente ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    await this.dataSource.query('DELETE FROM photo_staged_upload WHERE id = $1', [row.id]);
    return true;
  }

  private async process(file: PhotoUpload | undefined): Promise<ProcessedImage> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Adjunte una foto.');
    }
    return withImageErrors(() =>
      processImage(file.buffer, {
        allowed: PHOTO_MIMES,
        maxWidth: ASSET_PHOTO_LIMITS.maxStoredSide,
        maxHeight: ASSET_PHOTO_LIMITS.maxStoredSide,
      }),
    );
  }

  private async withKeyRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        if (attempt >= MAX_KEY_ATTEMPTS) {
          throw new ApiException(ErrorCode.AssetPhotoKeyConflict);
        }
      }
    }
  }

  private async lockAsset(manager: EntityManager, assetId: string): Promise<LockedAsset> {
    const [asset] = (await manager.query(
      `SELECT a.id, a.internal_code, cc.id AS cost_center_id, cc.external_code AS cost_center_code
       FROM asset a JOIN cost_center cc ON cc.id = a.current_cost_center_id
       WHERE a.id = $1
       FOR UPDATE OF a`,
      [assetId],
    )) as LockedAsset[];
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return asset;
  }

  private async storeFile(
    manager: EntityManager,
    asset: LockedAsset,
    processed: ProcessedImage,
    thumbnail: ProcessedImage,
    actor: AuthenticatedUser,
    uploadedAt: Date,
  ): Promise<string> {
    const naming = { uploadedAt, costCenterCode: asset.cost_center_code, assetCode: asset.internal_code };
    const stem = assetPhotoStem(naming);
    const existing = (await manager.query('SELECT storage_key FROM photo_file WHERE starts_with(storage_key, $1)', [
      stem,
    ])) as Array<{ storage_key: string }>;
    const seq = nextPhotoSequence(
      stem,
      existing.map((row) => row.storage_key),
    );
    const key = assetPhotoKey({ ...naming, seq, ext: IMAGE_EXTENSION[processed.mime] });
    const thumbKey = assetPhotoThumbKey({ ...naming, seq });
    const [inserted] = (await manager.query(
      `INSERT INTO photo_file (storage_driver, storage_key, thumb_key, sha256, content_type, byte_size, width, height,
         cost_center_id, upload_year, origin_asset_id, uploaded_by, uploaded_at)
       VALUES ('project', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        key,
        thumbKey,
        sha256Of(processed.content),
        processed.mime,
        processed.content.length,
        processed.width,
        processed.height,
        asset.cost_center_id,
        Number(storageYear(uploadedAt)),
        asset.id,
        actor.id,
        uploadedAt,
      ],
    )) as Array<{ id: string }>;
    const fileId = inserted?.id ?? '';
    const stored = await this.storage.put({ key, body: processed.content, contentType: processed.mime });
    await this.storage.put({ key: thumbKey, body: thumbnail.content, contentType: thumbnail.mime });
    await manager.query('UPDATE photo_file SET storage_driver = $1 WHERE id = $2', [stored.driver, fileId]);
    return fileId;
  }

  private async attach(
    manager: EntityManager,
    assetId: string,
    fileId: string,
    sha256: string,
    actor: AuthenticatedUser,
    options: PhotoUploadOptions,
  ): Promise<string> {
    const primary =
      options.primary ??
      ((await manager.query('SELECT 1 FROM asset_photo WHERE asset_id = $1 AND is_primary', [assetId])) as unknown[])
        .length === 0;
    if (primary) {
      await manager.query('UPDATE asset_photo SET is_primary = FALSE WHERE asset_id = $1 AND is_primary', [assetId]);
    }
    const [row] = (await manager.query(
      `INSERT INTO asset_photo (asset_id, file_id, file_hash, is_primary, caption, uploaded_at, uploaded_by, linked_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $6)
       RETURNING id`,
      [assetId, fileId, sha256, primary, options.caption ?? null, actor.id],
    )) as Array<{ id: string }>;
    if (primary) {
      await this.clearPhotoMissing(manager, assetId);
    }
    return row?.id ?? '';
  }

  private async clearPhotoMissing(manager: EntityManager, assetId: string): Promise<void> {
    await manager.query(
      `UPDATE asset SET data_quality_flags = array_remove(data_quality_flags, 'PHOTO_MISSING')
       WHERE id = $1 AND 'PHOTO_MISSING' = ANY(data_quality_flags)`,
      [assetId],
    );
  }

  private async photo(assetId: string, photoId: string, manager?: EntityManager): Promise<AssetPhotoResponseDto> {
    const runner = manager ?? this.dataSource;
    const [row] = (await runner.query(`${PHOTO_SELECT} AND ph.id = $2`, [assetId, photoId])) as PhotoRow[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return toDto(row);
  }

  private async assertReadable(assetId: string, scope: ReadableCostCenterScope): Promise<void> {
    const rows = (await this.dataSource.query(
      'SELECT 1 FROM asset WHERE id = $1 AND ($2::uuid[] IS NULL OR current_cost_center_id = ANY($2::uuid[]))',
      [assetId, costCenterFilter(scope)],
    )) as unknown[];
    if (rows.length === 0) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
  }

  private contentOf(row: StoredFileRow, variant: PhotoVariant): PhotoContent {
    const key = variant === 'thumbnail' ? row.thumb_key : row.storage_key;
    return {
      contentType: variant === 'thumbnail' ? 'image/webp' : row.content_type,
      etag: variant === 'thumbnail' ? `"${row.sha256}-${ASSET_PHOTO_LIMITS.thumbnailSide}"` : `"${row.sha256}"`,
      fileName: key.slice(key.lastIndexOf('/') + 1),
      read: () => this.storage.getFrom(row.storage_driver, key),
    };
  }

  private audit(
    action: AuditAction,
    entityType: string,
    entityId: string,
    actor: AuthenticatedUser,
    changes: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    return this.auditLogs.record(
      { action, entityType, entityId, performedBy: actor.id, ipAddress: null, userAgent: null, changes },
      manager,
    );
  }
}
