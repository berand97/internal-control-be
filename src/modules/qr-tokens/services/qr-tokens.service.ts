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
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import type { AssetsRepository } from '../../assets/repositories/assets.repository.interface.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { QrTokenRotationLog } from '../entities/qr-token-rotation-log.entity.js';
import type {
  QrHistoryItemDto,
  QrTokenResponseDto,
  QrVerifyAuthResponseDto,
  QrVerifyPublicResponseDto,
} from '../dto/responses/qr-token.response.dto.js';

const ASSET_READ_GLOBAL = 'asset:read:global';
const ASSET_READ_SCOPED = 'asset:read:org_unit';

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
    private readonly config: ConfigService<AppConfig, true>,
    private readonly assetState: AssetStateService,
    private readonly permissions: PermissionsService,
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
    const signedAt = new Date();
    await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: {
        qrToken: token,
        qrTokenVersion: version,
        qrSignedAt: signedAt,
        qrSignedBy: actor.id,
      },
      guard: (current) => {
        if (current.operationalStatus === OperationalStatus.WrittenOff) {
          throw new ApiException(ErrorCode.QrAssetWrittenOff);
        }
      },
      movement: {
        type: MovementType.QrRotation,
        reason: 'Rotación de QR',
        documentReference: null,
      },
      audit: { action: AuditAction.QrIssued, changes: { tokenVersion: version } },
      alsoWrite: async (manager) => {
        const rotations = manager.getRepository(QrTokenRotationLog);
        await rotations.save(
          rotations.create({
            assetId: asset.id,
            tokenVersion: version,
            jti,
            action: 'ISSUED',
            performedBy: actor.id,
            createdAt: signedAt,
          }),
        );
      },
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
    await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: {
        qrToken: null,
        qrTokenVersion: nextVersion,
        qrSignedAt: null,
        qrSignedBy: null,
      },
      audit: { action: AuditAction.QrRevoked, changes: { tokenVersion: nextVersion } },
      alsoWrite: async (manager) => {
        const rotations = manager.getRepository(QrTokenRotationLog);
        await rotations.save(
          rotations.create({
            assetId: asset.id,
            tokenVersion: nextVersion,
            jti: randomUUID(),
            action: 'REVOKED',
            performedBy: actor.id,
            createdAt: new Date(),
          }),
        );
      },
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

  /**
   * Verificación con sesión Y alcance (decisión del desarrollador: la etiqueta no expone activos de otro centro).
   * Con asset:read:global, o asset:read:org_unit con el centro de costo ACTUAL del activo entre los del usuario
   * (asignaciones COST_CENTER ∪ jefaturas), devuelve los datos. Token alterado, activo inexistente, activo de otro
   * centro o usuario sin alcance: 400 QR_TOKEN_INVALID, la misma respuesta en todos los casos (no distingue «existe
   * pero no es tuyo»). QR_VERSION_MISMATCH solo se informa sobre activos del alcance.
   */
  async verify(
    token: string,
    actor: AuthenticatedUser,
    withPng: boolean,
    size: number,
  ): Promise<QrVerifyPublicResponseDto & { pngBase64?: string }> {
    const { payload, asset } = await this.assetInScope(token, actor);
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

  /** verify con movimientos recientes y préstamos activos: mismo alcance y mismas respuestas. */
  async verifyAuthenticated(token: string, actor: AuthenticatedUser): Promise<QrVerifyAuthResponseDto> {
    const verified = await this.verify(token, actor, false, 300);
    const assetId = this.decode(token).assetId;
    const [movements, loans] = await Promise.all([
      this.assetsRepository.findRecentMovements(assetId, 5),
      this.assetsRepository.findActiveLoans(assetId),
    ]);
    return {
      ...verified,
      recentMovements: movements.map((item) => ({
        id: item.id,
        movementType: item.movementType,
        executedAt: item.executedAt,
        reason: item.reason,
      })),
      activeLoans: loans,
    };
  }

  /** El activo del token si el usuario lo alcanza; si no (o no existe), QR_TOKEN_INVALID como un token alterado. */
  private async assetInScope(token: string, actor: AuthenticatedUser) {
    const payload = this.decode(token);
    const asset = await this.assetsRepository.findById(payload.assetId);
    if (!asset) {
      throw new ApiException(ErrorCode.QrTokenInvalid);
    }
    const scope = await this.permissions.costCenterScope(actor.id, ASSET_READ_GLOBAL, ASSET_READ_SCOPED);
    const inScope =
      scope.kind === 'GLOBAL' || (scope.kind === 'COST_CENTERS' && scope.costCenterIds.includes(asset.costCenterId));
    if (!inScope) {
      throw new ApiException(ErrorCode.QrTokenInvalid);
    }
    return { payload, asset };
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
