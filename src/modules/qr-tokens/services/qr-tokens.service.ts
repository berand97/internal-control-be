import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AppConfig } from '../../../config/configuration.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import type { AssetsRepository } from '../../assets/repositories/assets.repository.interface.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { MovementsService } from '../../movements/services/movements.service.js';
import { QrTokenRotationLog } from '../entities/qr-token-rotation-log.entity.js';
import type {
  QrHistoryItemDto,
  QrTokenResponseDto,
  QrVerifyAuthResponseDto,
  QrVerifyPublicResponseDto,
} from '../dto/responses/qr-token.response.dto.js';

interface QrPayload {
  readonly typ: 'qr';
  readonly assetId: string;
  readonly tokenVersion: number;
  readonly jti: string;
}

const isQrPayload = (value: unknown): value is QrPayload => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['typ'] === 'qr' &&
    typeof record['assetId'] === 'string' &&
    typeof record['tokenVersion'] === 'number' &&
    typeof record['jti'] === 'string'
  );
};

@Injectable()
export class QrTokensService {
  constructor(
    @Inject('AssetsRepository')
    private readonly assetsRepository: AssetsRepository,
    @InjectRepository(QrTokenRotationLog)
    private readonly rotations: Repository<QrTokenRotationLog>,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly movementsService: MovementsService,
  ) {}

  async issue(
    assetId: string,
    actor: AuthenticatedUser,
    withPng: boolean,
    size: number,
  ): Promise<QrTokenResponseDto> {
    const asset = await this.requireAsset(assetId);
    if (asset.operationalStatus === OperationalStatus.WrittenOff) {
      throw new ApiException(ErrorCode.QrAssetWrittenOff);
    }
    const nextVersion = asset.qrTokenVersion + (asset.qrToken ? 1 : 0);
    const version = asset.qrToken ? nextVersion : asset.qrTokenVersion;
    const jti = randomUUID();
    const token = this.sign({
      typ: 'qr',
      assetId: asset.id,
      tokenVersion: version,
      jti,
    });
    await this.assetsRepository.update(asset.id, {
      qrToken: token,
      qrTokenVersion: version,
      qrSignedAt: new Date(),
      qrSignedBy: actor.id,
      updatedBy: actor.id,
    });
    await this.rotations.save(
      this.rotations.create({
        assetId: asset.id,
        tokenVersion: version,
        jti,
        action: 'ISSUED',
        performedBy: actor.id,
        createdAt: new Date(),
      }),
    );
    await this.auditLogsRepository.record({
      action: AuditAction.QrIssued,
      entityType: 'ASSET',
      entityId: asset.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { tokenVersion: version },
    });
    await this.movementsService.record({
      assetId: asset.id,
      movementType: MovementType.QrRotation,
      fromCostCenterId: asset.costCenterId,
      fromLocationId: asset.locationId,
      fromResponsibleId: asset.responsibleId,
      fromOperationalStatus: asset.operationalStatus,
      fromPhysicalCondition: asset.physicalCondition,
      toCostCenterId: asset.costCenterId,
      toLocationId: asset.locationId,
      toResponsibleId: asset.responsibleId,
      toOperationalStatus: asset.operationalStatus,
      toPhysicalCondition: asset.physicalCondition,
      requestedBy: actor.id,
      authorizedBy: actor.id,
      reason: 'Rotación de QR',
      documentReference: null,
    });
    return this.toTokenResponse(token, version, new Date(), withPng, size);
  }

  async current(
    assetId: string,
    withPng: boolean,
    size: number,
  ): Promise<QrTokenResponseDto> {
    const asset = await this.requireAsset(assetId);
    if (!asset.qrToken) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.toTokenResponse(
      asset.qrToken,
      asset.qrTokenVersion,
      asset.qrSignedAt,
      withPng,
      size,
    );
  }

  async revoke(assetId: string, actor: AuthenticatedUser): Promise<null> {
    const asset = await this.requireAsset(assetId);
    if (!asset.qrToken) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const nextVersion = asset.qrTokenVersion + 1;
    await this.assetsRepository.update(asset.id, {
      qrToken: null,
      qrTokenVersion: nextVersion,
      qrSignedAt: null,
      qrSignedBy: null,
      updatedBy: actor.id,
    });
    await this.rotations.save(
      this.rotations.create({
        assetId: asset.id,
        tokenVersion: nextVersion,
        jti: randomUUID(),
        action: 'REVOKED',
        performedBy: actor.id,
        createdAt: new Date(),
      }),
    );
    await this.auditLogsRepository.record({
      action: AuditAction.QrRevoked,
      entityType: 'ASSET',
      entityId: asset.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { tokenVersion: nextVersion },
    });
    return null;
  }

  async history(assetId: string): Promise<ReadonlyArray<QrHistoryItemDto>> {
    await this.requireAsset(assetId);
    const rows = await this.rotations.find({
      where: { assetId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => ({
      id: row.id,
      tokenVersion: row.tokenVersion,
      action: row.action,
      performedBy: row.performedBy,
      createdAt: row.createdAt,
    }));
  }

  async verifyPublic(
    token: string,
    withPng: boolean,
    size: number,
  ): Promise<QrVerifyPublicResponseDto & { pngBase64?: string }> {
    const payload = this.decode(token);
    const asset = await this.assetsRepository.findById(payload.assetId);
    if (!asset) {
      throw new ApiException(ErrorCode.QrAssetNotFound);
    }
    if (payload.tokenVersion !== asset.qrTokenVersion || !asset.qrToken) {
      throw new ApiException(ErrorCode.QrVersionMismatch);
    }
    const category = await this.assetsRepository.findNamedCategory(
      asset.categoryId,
    );
    const costCenter = await this.assetsRepository.findNamedCostCenter(
      asset.costCenterId,
    );
    const location = asset.locationId
      ? await this.assetsRepository.findNamedLocation(asset.locationId)
      : null;
    const publicAsset = {
      internalCode: asset.internalCode,
      description: asset.description,
      categoryName: category?.name ?? '',
      costCenterName: costCenter?.name ?? '',
      locationName: location?.name ?? null,
      operationalStatus: asset.operationalStatus,
    };
    if (!withPng) {
      return { tokenVersion: asset.qrTokenVersion, asset: publicAsset };
    }
    const pngBase64 = await QRCode.toDataURL(token, {
      width: size,
      margin: 1,
    });
    return {
      tokenVersion: asset.qrTokenVersion,
      asset: publicAsset,
      pngBase64,
    };
  }

  async verifyAuthenticated(token: string): Promise<QrVerifyAuthResponseDto> {
    const publicData = await this.verifyPublic(token, false, 300);
    const asset = await this.assetsRepository.findById(
      this.decode(token).assetId,
    );
    if (!asset) {
      throw new ApiException(ErrorCode.QrAssetNotFound);
    }
    const [movements, loans] = await Promise.all([
      this.assetsRepository.findRecentMovements(asset.id, 5),
      this.assetsRepository.findActiveLoans(asset.id),
    ]);
    return {
      ...publicData,
      recentMovements: movements.map((item) => ({
        id: item.id,
        movementType: item.movementType,
        executedAt: item.executedAt,
        reason: item.reason,
      })),
      activeLoans: loans,
    };
  }

  private sign(payload: QrPayload): string {
    const secret = this.config.getOrThrow('jwt.qrSecret', { infer: true });
    return jwt.sign(payload, secret, { algorithm: 'HS256' });
  }

  private decode(token: string): QrPayload {
    try {
      const secret = this.config.getOrThrow('jwt.qrSecret', { infer: true });
      const decoded: unknown = jwt.verify(token, secret, {
        algorithms: ['HS256'],
      });
      if (!isQrPayload(decoded)) {
        throw new ApiException(ErrorCode.QrTokenInvalid);
      }
      return decoded;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      throw new ApiException(ErrorCode.QrTokenInvalid);
    }
  }

  private async requireAsset(assetId: string) {
    const asset = await this.assetsRepository.findById(assetId);
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return asset;
  }

  private async toTokenResponse(
    token: string,
    tokenVersion: number,
    qrSignedAt: Date | null,
    withPng: boolean,
    size: number,
  ): Promise<QrTokenResponseDto> {
    const response: QrTokenResponseDto = {
      token,
      tokenVersion,
      qrSignedAt,
    };
    if (!withPng) {
      return response;
    }
    const pngBase64 = await QRCode.toDataURL(token, {
      width: size,
      margin: 1,
    });
    return { ...response, pngBase64 };
  }
}
