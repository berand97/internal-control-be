import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type {
  AppConfig,
  S3Provider,
  StorageConfig,
  StorageDriver,
} from '../../config/configuration.js';
import { SecretCipherService } from '../crypto/secret-cipher.service.js';
import {
  assertDestinationAllowed,
  isOutboundForbidden,
  normalizeHost,
  type OutboundPolicy,
} from '../net/outbound-destination.js';
import { GoogleDriveStorageAdapter } from './adapters/google-drive-storage.adapter.js';
import { OneDriveStorageAdapter } from './adapters/onedrive-storage.adapter.js';
import { ProjectStorageAdapter } from './adapters/project-storage.adapter.js';
import { S3StorageAdapter, type S3ClientTuning } from './adapters/s3-storage.adapter.js';
import type { StorageStatusDto } from './dto/storage-status.responses.js';
import { StorageSettings } from './entities/storage-settings.entity.js';
import { parseDriveFolderId } from './parse-drive-folder-id.js';
import {
  STORAGE_PROBE_PREFIX,
  failed,
  passed,
  skipped,
  type BucketState,
  type StorageCheck,
  type StorageCheckName,
} from './s3-connection-probe.js';
import { S3_PROVIDER_PRESETS } from './s3-provider.presets.js';
import {
  PublicAssetsConfigError,
  normalizePublicAssetsBaseUrl,
  normalizePublicAssetsBucket,
  publicAssetUrl,
} from './public-assets.js';
import { assertSafeStorageKey } from './storage-key.js';
import { EMAIL_IMAGE_KEY_PREFIX, isPublicKey } from './storage-keys.js';
import type { PutObjectInput, StoragePort, StoredObject } from './storage.port.js';

export type OauthProvider = 'google_drive' | 'onedrive';

export interface PublicAssetInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface StoredPublicAsset {
  readonly key: string;
  readonly publicUrl: string;
}

export const OAUTH_STATE_TTL_SECONDS = 600;

export const STORAGE_SECRET_FIELDS = [
  's3SecretKey',
  'googleClientSecret',
  'googleRefreshToken',
  'onedriveClientSecret',
  'onedriveRefreshToken',
] as const satisfies ReadonlyArray<keyof StorageSettings>;

const S3_TEST_TUNING: S3ClientTuning = { maxAttempts: 1, connectionTimeoutMs: 5000, requestTimeoutMs: 15000 };

export interface StorageTestResult {
  readonly ok: boolean;
  readonly driver: StorageDriver;
  readonly checkedAt: string;
  readonly checks: ReadonlyArray<StorageCheck>;
  readonly bucket: BucketState | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const sameHash = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

const canonicalPath = (value: string): string => {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

const mask = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  if (value.length <= 4) {
    return '****';
  }
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
};

const assertPrivateKey = (key: string): void => {
  assertSafeStorageKey(key);
  if (isPublicKey(key)) {
    throw new ApiException(ErrorCode.StorageKeyInvalid);
  }
};

const assertEmailImageKey = (key: string): void => {
  assertSafeStorageKey(key);
  if (!key.startsWith(EMAIL_IMAGE_KEY_PREFIX)) {
    throw new ApiException(ErrorCode.StorageKeyInvalid);
  }
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private warnedIgnoredProjectPath = false;

  constructor(
    @InjectRepository(StorageSettings)
    private readonly settings: Repository<StorageSettings>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly cipher: SecretCipherService,
  ) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    assertPrivateKey(input.key);
    return (await this.resolveAdapter()).put(input);
  }

  async get(key: string): Promise<Buffer> {
    assertSafeStorageKey(key);
    return (await this.resolveAdapter()).get(key);
  }

  async getFrom(driver: StorageDriver, key: string): Promise<Buffer> {
    assertSafeStorageKey(key);
    return (await this.resolveAdapter(driver)).get(key);
  }

  async delete(key: string): Promise<void> {
    assertPrivateKey(key);
    return (await this.resolveAdapter()).delete(key);
  }

  async exists(key: string): Promise<boolean> {
    assertSafeStorageKey(key);
    return (await this.resolveAdapter()).exists(key);
  }

  async presignGet(key: string, expiresInSeconds = 3600): Promise<string> {
    assertSafeStorageKey(key);
    return (await this.resolveAdapter()).presignGet(key, expiresInSeconds);
  }

  async status(): Promise<StorageStatusDto> {
    const resolved = await this.resolvedConfig();
    const needsOauth =
      (resolved.driver === 'google_drive' && !resolved.google.refreshToken) ||
      (resolved.driver === 'onedrive' && !resolved.onedrive.refreshToken);
    return {
      driver: resolved.driver,
      projectPath: resolved.projectPath,
      s3Provider: resolved.s3.provider,
      s3Endpoint: resolved.s3.endpoint,
      s3Region: resolved.s3.region,
      s3Bucket: resolved.s3.bucket,
      s3ForcePathStyle: resolved.s3.forcePathStyle,
      s3PublicAssetsBucket: resolved.s3.publicAssetsBucket,
      s3PublicAssetsBaseUrl: resolved.s3.publicAssetsBaseUrl,
      s3AccessKeySet: Boolean(resolved.s3.accessKey),
      s3SecretKeySet: Boolean(resolved.s3.secretKey),
      googleConnected: Boolean(resolved.google.refreshToken),
      onedriveConnected: Boolean(resolved.onedrive.refreshToken),
      googleClientId: mask(resolved.google.clientId),
      googleClientSecretSet: Boolean(resolved.google.clientSecret),
      googleFolderId: resolved.google.folderId,
      onedriveClientId: mask(resolved.onedrive.clientId),
      onedriveClientSecretSet: Boolean(resolved.onedrive.clientSecret),
      needsOauth,
      authorizationUrl: null,
    };
  }

  async testConnection(): Promise<StorageTestResult> {
    const resolved = await this.resolvedConfig();
    if (resolved.driver === 's3') {
      return this.testS3(resolved);
    }
    const adapter = await this.resolveAdapter();
    const key = `${STORAGE_PROBE_PREFIX}probe-${Date.now()}.txt`;
    const body = Buffer.from('ok');
    await adapter.put({ key, body, contentType: 'text/plain' });
    const read = await adapter.get(key);
    await adapter.delete(key);
    const checks: StorageCheck[] = [
      passed('CONFIGURATION'),
      skipped('DESTINATION'),
      passed('WRITE'),
      read.equals(body) ? passed('READ') : failed('READ', 'CONTENT_MISMATCH', 'El archivo de prueba leído no coincide con el escrito.'),
      passed('DELETE'),
    ];
    return this.testResult(adapter.driver, checks, null);
  }

  private async testS3(resolved: StorageConfig): Promise<StorageTestResult> {
    const s3 = resolved.s3;
    const rest: ReadonlyArray<StorageCheckName> = [
      'ENDPOINT',
      'CREDENTIALS',
      'BUCKET',
      'WRITE',
      'READ',
      'DELETE',
      'VERSIONING',
      'OBJECT_LOCK',
    ];
    if (!s3.bucket || !s3.accessKey || !s3.secretKey) {
      return this.testResult(
        's3',
        [
          failed('CONFIGURATION', 'STORAGE_NOT_CONFIGURED', 'Faltan el bucket, la clave de acceso o la clave secreta.'),
          skipped('DESTINATION'),
          ...rest.map(skipped),
        ],
        null,
      );
    }
    const checks: StorageCheck[] = [passed('CONFIGURATION')];
    const endpoint = s3.endpoint ?? S3_PROVIDER_PRESETS[s3.provider].defaultEndpoint(s3.region);
    if (endpoint) {
      try {
        await this.assertS3EndpointAllowed(endpoint);
        checks.push(passed('DESTINATION'));
      } catch (error) {
        if (!(error instanceof ApiException)) {
          throw error;
        }
        checks.push(
          error.code === ErrorCode.OutboundDestinationForbidden
            ? failed(
                'DESTINATION',
                'OUTBOUND_DESTINATION_FORBIDDEN',
                'El servidor está en una red interna. Use una dirección pública.',
              )
            : failed('DESTINATION', 'ENDPOINT_NOT_ALLOWED', error.message),
        );
        return this.testResult('s3', [...checks, ...rest.map(skipped)], null);
      }
    } else {
      checks.push(passed('DESTINATION', 'Se usa la dirección del proveedor.'));
    }
    let adapter: S3StorageAdapter;
    try {
      adapter = this.s3Adapter(resolved, S3_TEST_TUNING);
    } catch (error) {
      if (!isOutboundForbidden(error)) {
        throw error;
      }
      checks[checks.length - 1] = failed(
        'DESTINATION',
        'OUTBOUND_DESTINATION_FORBIDDEN',
        'El servidor está en una red interna. Use una dirección pública.',
      );
      return this.testResult('s3', [...checks, ...rest.map(skipped)], null);
    }
    const probe = await adapter.probe();
    return this.testResult('s3', [...checks, ...probe.checks], probe.bucket);
  }

  private testResult(
    driver: StorageDriver,
    checks: ReadonlyArray<StorageCheck>,
    bucket: BucketState | null,
  ): StorageTestResult {
    return {
      ok: checks.every((check) => check.status !== 'FAILED'),
      driver,
      checkedAt: new Date().toISOString(),
      checks,
      bucket,
    };
  }

  async updateSettings(
    patch: Partial<{
      driver: StorageDriver;
      projectPath: string;
      s3Provider: S3Provider;
      s3Endpoint: string | null;
      s3Region: string;
      s3Bucket: string | null;
      s3AccessKey: string | null;
      s3SecretKey: string | null;
      s3ForcePathStyle: boolean;
      s3PublicAssetsBucket: string | null;
      s3PublicAssetsBaseUrl: string | null;
      googleClientId: string | null;
      googleClientSecret: string | null;
      googleFolderId: string | null;
      onedriveTenantId: string | null;
      onedriveClientId: string | null;
      onedriveClientSecret: string | null;
      onedriveFolderId: string | null;
    }>,
    actorId: string,
  ): Promise<void> {
    this.assertProjectPathUnchanged(patch.projectPath);
    if (patch.s3Endpoint) {
      await this.assertS3EndpointAllowed(patch.s3Endpoint);
    }
    const row = await this.requireRow();
    const nextDriver = patch.driver ?? row.driver;
    const nextGoogleId = patch.googleClientId ?? row.googleClientId;
    const nextGoogleSecret = patch.googleClientSecret ?? row.googleClientSecret;
    const nextOnedriveId = patch.onedriveClientId ?? row.onedriveClientId;
    const nextOnedriveSecret = patch.onedriveClientSecret ?? row.onedriveClientSecret;
    if (nextDriver === 'google_drive' && (!nextGoogleId || !nextGoogleSecret)) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        'Escriba el Client ID y el Client Secret de Google.',
      );
    }
    if (nextDriver === 'onedrive' && (!nextOnedriveId || !nextOnedriveSecret)) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        'Escriba el Client ID y el Client Secret de OneDrive.',
      );
    }
    if (patch.driver !== undefined) {
      row.driver = patch.driver;
    }
    if (patch.s3Provider !== undefined) {
      row.s3Provider = patch.s3Provider;
    }
    if (patch.s3Endpoint !== undefined) {
      row.s3Endpoint = patch.s3Endpoint;
    }
    if (patch.s3Region !== undefined) {
      row.s3Region = patch.s3Region;
    }
    if (patch.s3Bucket !== undefined) {
      row.s3Bucket = patch.s3Bucket;
    }
    if (patch.s3AccessKey !== undefined) {
      row.s3AccessKey = patch.s3AccessKey;
    }
    if (patch.s3SecretKey !== undefined) {
      row.s3SecretKey = patch.s3SecretKey;
    }
    if (patch.s3ForcePathStyle !== undefined) {
      row.s3ForcePathStyle = patch.s3ForcePathStyle;
    }
    try {
      if (patch.s3PublicAssetsBucket !== undefined) {
        row.s3PublicAssetsBucket =
          patch.s3PublicAssetsBucket === null ? null : normalizePublicAssetsBucket(patch.s3PublicAssetsBucket);
      }
      if (patch.s3PublicAssetsBaseUrl !== undefined) {
        row.s3PublicAssetsBaseUrl =
          patch.s3PublicAssetsBaseUrl === null
            ? null
            : normalizePublicAssetsBaseUrl(patch.s3PublicAssetsBaseUrl, process.env['NODE_ENV'] === 'production');
      }
    } catch (error) {
      if (error instanceof PublicAssetsConfigError) {
        throw new ApiException(ErrorCode.ValidationFailed, error.message);
      }
      throw error;
    }
    if (patch.googleClientId !== undefined) {
      row.googleClientId = patch.googleClientId;
    }
    if (patch.googleClientSecret !== undefined) {
      row.googleClientSecret = patch.googleClientSecret;
    }
    if (patch.googleFolderId !== undefined) {
      row.googleFolderId = parseDriveFolderId(patch.googleFolderId) ?? null;
    }
    if (patch.onedriveTenantId !== undefined) {
      row.onedriveTenantId = patch.onedriveTenantId;
    }
    if (patch.onedriveClientId !== undefined) {
      row.onedriveClientId = patch.onedriveClientId;
    }
    if (patch.onedriveClientSecret !== undefined) {
      row.onedriveClientSecret = patch.onedriveClientSecret;
    }
    if (patch.onedriveFolderId !== undefined) {
      row.onedriveFolderId = patch.onedriveFolderId;
    }
    row.updatedAt = new Date();
    row.updatedBy = actorId;
    await this.settings.save(this.seal(row));
  }

  async startOauth(
    provider: OauthProvider,
    userId: string,
  ): Promise<{ readonly authorizationUrl: string; readonly browserBinding: string }> {
    const resolved = await this.resolvedConfig();
    const clientId =
      provider === 'google_drive' ? resolved.google.clientId : resolved.onedrive.clientId;
    if (!clientId) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        provider === 'google_drive'
          ? 'Guarde el Client ID y el Client Secret de Google antes de conectar la cuenta.'
          : 'Guarde el Client ID y el Client Secret de OneDrive antes de conectar la cuenta.',
      );
    }
    const state = randomBytes(32).toString('base64url');
    const browserBinding = randomBytes(32).toString('base64url');
    await this.settings.manager.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM storage_oauth_state WHERE expires_at < NOW() - INTERVAL '1 day'`,
      );
      await manager.query(
        `INSERT INTO storage_oauth_state (state_hash, browser_hash, user_id, provider, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))`,
        [sha256(state), sha256(browserBinding), userId, provider, OAUTH_STATE_TTL_SECONDS],
      );
    });
    const redirectUri = this.redirectUri(provider);
    if (provider === 'google_drive') {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/drive.file',
        state,
      });
      return {
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        browserBinding,
      };
    }
    const tenant = resolved.onedrive.tenantId || 'common';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: 'offline_access Files.ReadWrite',
      state,
    });
    return {
      authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`,
      browserBinding,
    };
  }

  async oauthCallback(
    provider: OauthProvider,
    code: unknown,
    state: unknown,
    browserBinding: unknown,
  ): Promise<void> {
    if (
      typeof state !== 'string' ||
      state.length === 0 ||
      state.length > 128 ||
      typeof code !== 'string' ||
      code.length === 0
    ) {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    const consumed = (await this.settings.manager.query(
      `UPDATE storage_oauth_state SET consumed_at = NOW()
        WHERE state_hash = $1 AND consumed_at IS NULL
        RETURNING user_id, provider, browser_hash, expires_at > NOW() AS fresh`,
      [sha256(state)],
    )) as [Array<{ user_id: string; provider: string; browser_hash: string; fresh: boolean }>, number];
    const claim = consumed[0]?.[0];
    if (
      !claim ||
      !claim.fresh ||
      claim.provider !== provider ||
      typeof browserBinding !== 'string' ||
      browserBinding.length === 0 ||
      !sameHash(sha256(browserBinding), claim.browser_hash)
    ) {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    const [user] = (await this.settings.manager.query(
      `SELECT status FROM app_user WHERE id = $1`,
      [claim.user_id],
    )) as Array<{ status: string }>;
    if (user?.status !== 'ACTIVE') {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    const resolved = await this.resolvedConfig();
    const redirectUri = this.redirectUri(provider);
    const refreshToken =
      provider === 'google_drive'
        ? await this.exchangeGoogle(code, redirectUri, resolved)
        : await this.exchangeOnedrive(code, redirectUri, resolved);
    const row = await this.requireRow();
    if (provider === 'google_drive') {
      row.googleRefreshToken = refreshToken;
      row.driver = 'google_drive';
    } else {
      row.onedriveRefreshToken = refreshToken;
      row.driver = 'onedrive';
    }
    row.updatedAt = new Date();
    row.updatedBy = claim.user_id;
    await this.settings.save(this.seal(row));
  }

  private redirectUri(provider: OauthProvider): string {
    return `${this.config.getOrThrow('apiPublicUrl', { infer: true })}/api/v1/storage/oauth/${provider === 'google_drive' ? 'google' : 'onedrive'}/callback`;
  }

  private async exchangeGoogle(
    code: string,
    redirectUri: string,
    resolved: StorageConfig,
  ): Promise<string> {
    if (!resolved.google.clientId || !resolved.google.clientSecret) {
      throw new ApiException(ErrorCode.StorageNotConfigured);
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: resolved.google.clientId,
        client_secret: resolved.google.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!response.ok) {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    const payload = (await response.json()) as { refresh_token?: unknown };
    if (typeof payload.refresh_token !== 'string') {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    return payload.refresh_token;
  }

  private async exchangeOnedrive(
    code: string,
    redirectUri: string,
    resolved: StorageConfig,
  ): Promise<string> {
    if (!resolved.onedrive.clientId || !resolved.onedrive.clientSecret) {
      throw new ApiException(ErrorCode.StorageNotConfigured);
    }
    const tenant = resolved.onedrive.tenantId || 'common';
    const response = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: resolved.onedrive.clientId,
          client_secret: resolved.onedrive.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      },
    );
    if (!response.ok) {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    const payload = (await response.json()) as { refresh_token?: unknown };
    if (typeof payload.refresh_token !== 'string') {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    return payload.refresh_token;
  }

  private assertProjectPathUnchanged(requested: string | undefined): void {
    if (requested === undefined) {
      return;
    }
    const deployed = this.config.getOrThrow('storage', { infer: true }).projectPath;
    if (canonicalPath(requested) !== canonicalPath(deployed)) {
      throw new ApiException(ErrorCode.StorageProjectPathLocked);
    }
  }

  private outboundPolicy(): OutboundPolicy {
    return this.config.getOrThrow('outbound', { infer: true });
  }

  private async assertS3EndpointAllowed(endpoint: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ApiException(ErrorCode.ValidationFailed, 'La dirección del servidor S3 debe empezar por https.');
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        'La dirección del servidor S3 no puede llevar usuario ni parámetros.',
      );
    }
    const policy = this.outboundPolicy();
    const listed = policy.allowedHosts.some(
      (allowed) => normalizeHost(allowed) === normalizeHost(url.hostname),
    );
    try {
      await assertDestinationAllowed(url.hostname, policy);
    } catch (error) {
      if (isOutboundForbidden(error)) {
        throw new ApiException(ErrorCode.OutboundDestinationForbidden);
      }
      throw error;
    }
    if (url.protocol === 'http:' && !policy.allowPrivateNetworks && !listed) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La dirección del servidor S3 debe usar https.');
    }
  }

  private warnIgnoredProjectPath(stored: string | null, deployed: string): void {
    if (this.warnedIgnoredProjectPath || !stored) {
      return;
    }
    if (canonicalPath(stored) === canonicalPath(deployed)) {
      return;
    }
    this.warnedIgnoredProjectPath = true;
    this.logger.warn(
      `storage_settings.project_path ${JSON.stringify(stored)} se ignora: el almacenamiento local usa STORAGE_PROJECT_PATH ${JSON.stringify(deployed)}. Si allí había archivos, muévalos a esa carpeta.`,
    );
  }

  async putPublicAsset(input: PublicAssetInput): Promise<StoredPublicAsset> {
    assertEmailImageKey(input.key);
    const resolved = await this.resolvedConfig();
    const { publicAssetsBucket, publicAssetsBaseUrl } = resolved.s3;
    if (
      resolved.driver !== 's3' ||
      !publicAssetsBucket ||
      !publicAssetsBaseUrl ||
      !resolved.s3.accessKey ||
      !resolved.s3.secretKey
    ) {
      throw new ApiException(ErrorCode.PublicAssetsNotConfigured);
    }
    let adapter: S3StorageAdapter;
    try {
      adapter = this.s3Adapter({ ...resolved, s3: { ...resolved.s3, bucket: publicAssetsBucket } });
    } catch (error) {
      if (isOutboundForbidden(error)) {
        throw new ApiException(ErrorCode.OutboundDestinationForbidden);
      }
      throw error;
    }
    await adapter.put(input);
    return { key: input.key, publicUrl: publicAssetUrl(publicAssetsBaseUrl, input.key) };
  }

  async deletePublicAsset(key: string): Promise<void> {
    assertEmailImageKey(key);
    const resolved = await this.resolvedConfig();
    if (resolved.driver !== 's3' || !resolved.s3.publicAssetsBucket) {
      return;
    }
    await this.s3Adapter({ ...resolved, s3: { ...resolved.s3, bucket: resolved.s3.publicAssetsBucket } }).delete(key);
  }

  private s3Adapter(resolved: StorageConfig, tuning?: S3ClientTuning): S3StorageAdapter {
    if (!resolved.s3.bucket || !resolved.s3.accessKey || !resolved.s3.secretKey) {
      throw new ApiException(ErrorCode.StorageNotConfigured);
    }
    return new S3StorageAdapter(
      {
        provider: resolved.s3.provider,
        endpoint: resolved.s3.endpoint,
        region: resolved.s3.region,
        bucket: resolved.s3.bucket,
        accessKey: resolved.s3.accessKey,
        secretKey: resolved.s3.secretKey,
        forcePathStyle: resolved.s3.forcePathStyle,
      },
      this.outboundPolicy(),
      tuning,
    );
  }

  private async resolveAdapter(driver?: StorageDriver): Promise<StoragePort> {
    const configured = await this.resolvedConfig();
    const resolved = driver ? { ...configured, driver } : configured;
    if (resolved.driver === 'project') {
      return new ProjectStorageAdapter(
        path.resolve(resolved.projectPath),
        this.config.getOrThrow('apiPublicUrl', { infer: true }),
      );
    }
    if (resolved.driver === 's3') {
      if (!resolved.s3.bucket || !resolved.s3.accessKey || !resolved.s3.secretKey) {
        throw new ApiException(ErrorCode.StorageNotConfigured);
      }
      try {
        return this.s3Adapter(resolved);
      } catch (error) {
        if (isOutboundForbidden(error)) {
          throw new ApiException(ErrorCode.OutboundDestinationForbidden);
        }
        throw error;
      }
    }
    if (resolved.driver === 'google_drive') {
      if (!resolved.google.clientId || !resolved.google.clientSecret) {
        throw new ApiException(
          ErrorCode.StorageNotConfigured,
          'Escriba el Client ID y el Client Secret de Google.',
        );
      }
      if (!resolved.google.refreshToken) {
        throw new ApiException(ErrorCode.StorageOauthRequired);
      }
      return new GoogleDriveStorageAdapter({
        clientId: resolved.google.clientId,
        clientSecret: resolved.google.clientSecret,
        refreshToken: resolved.google.refreshToken,
        folderId: resolved.google.folderId,
      });
    }
    if (
      !resolved.onedrive.clientId ||
      !resolved.onedrive.clientSecret
    ) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        'Escriba el Client ID y el Client Secret de OneDrive.',
      );
    }
    if (!resolved.onedrive.refreshToken) {
      throw new ApiException(ErrorCode.StorageOauthRequired);
    }
    return new OneDriveStorageAdapter({
      tenantId: resolved.onedrive.tenantId ?? 'common',
      clientId: resolved.onedrive.clientId,
      clientSecret: resolved.onedrive.clientSecret,
      refreshToken: resolved.onedrive.refreshToken,
      folderId: resolved.onedrive.folderId,
    });
  }

  private async resolvedConfig(): Promise<StorageConfig> {
    const env = this.config.getOrThrow('storage', { infer: true });
    const stored = await this.settings.find({ take: 1 }).then((rows) => rows[0]);
    if (!stored) {
      return env;
    }
    const row = this.reveal(stored);
    if (STORAGE_SECRET_FIELDS.some((field) => this.cipher.needsReseal(stored[field]))) {
      await this.settings.save(this.seal(this.settings.create({ ...row })));
    }
    this.warnIgnoredProjectPath(row.projectPath, env.projectPath);
    return {
      driver: row.driver || env.driver,
      projectPath: env.projectPath,
      s3: {
        provider: row.s3Provider ?? env.s3.provider,
        endpoint: row.s3Endpoint ?? env.s3.endpoint,
        region: row.s3Region || env.s3.region,
        bucket: row.s3Bucket ?? env.s3.bucket,
        accessKey: row.s3AccessKey ?? env.s3.accessKey,
        secretKey: row.s3SecretKey ?? env.s3.secretKey,
        forcePathStyle: row.s3ForcePathStyle ?? env.s3.forcePathStyle,
        publicAssetsBucket: row.s3PublicAssetsBucket ?? env.s3.publicAssetsBucket ?? null,
        publicAssetsBaseUrl: row.s3PublicAssetsBaseUrl ?? env.s3.publicAssetsBaseUrl ?? null,
      },
      google: {
        clientId: row.googleClientId ?? env.google.clientId,
        clientSecret: row.googleClientSecret ?? env.google.clientSecret,
        refreshToken: row.googleRefreshToken ?? env.google.refreshToken,
        folderId: row.googleFolderId ?? env.google.folderId,
      },
      onedrive: {
        tenantId: row.onedriveTenantId ?? env.onedrive.tenantId,
        clientId: row.onedriveClientId ?? env.onedrive.clientId,
        clientSecret: row.onedriveClientSecret ?? env.onedrive.clientSecret,
        refreshToken: row.onedriveRefreshToken ?? env.onedrive.refreshToken,
        folderId: row.onedriveFolderId ?? env.onedrive.folderId,
      },
    };
  }

  private seal(row: StorageSettings): StorageSettings {
    for (const field of STORAGE_SECRET_FIELDS) {
      row[field] = this.cipher.encrypt(row[field]);
    }
    return row;
  }

  private reveal(row: StorageSettings): StorageSettings {
    try {
      const copy = this.settings.create({ ...row });
      for (const field of STORAGE_SECRET_FIELDS) {
        copy[field] = this.cipher.decrypt(row[field]);
      }
      return copy;
    } catch (error) {
      this.logger.error(
        'storage settings decrypt failed',
        error instanceof Error ? error.message : String(error),
      );
      throw new ApiException(ErrorCode.InternalError);
    }
  }

  private async requireRow(): Promise<StorageSettings> {
    const existing = await this.settings.find({ take: 1 }).then((rows) => rows[0]);
    if (existing) {
      return existing;
    }
    const env = this.config.getOrThrow('storage', { infer: true });
    const created = this.settings.create({
      driver: env.driver,
      projectPath: env.projectPath,
      s3Provider: env.s3.provider,
      s3Endpoint: env.s3.endpoint,
      s3Region: env.s3.region,
      s3Bucket: env.s3.bucket,
      s3AccessKey: env.s3.accessKey,
      s3SecretKey: env.s3.secretKey,
      s3ForcePathStyle: env.s3.forcePathStyle,
      s3PublicAssetsBucket: env.s3.publicAssetsBucket ?? null,
      s3PublicAssetsBaseUrl: env.s3.publicAssetsBaseUrl ?? null,
      googleClientId: env.google.clientId,
      googleClientSecret: env.google.clientSecret,
      googleRefreshToken: env.google.refreshToken,
      googleFolderId: env.google.folderId,
      onedriveTenantId: env.onedrive.tenantId,
      onedriveClientId: env.onedrive.clientId,
      onedriveClientSecret: env.onedrive.clientSecret,
      onedriveRefreshToken: env.onedrive.refreshToken,
      onedriveFolderId: env.onedrive.folderId,
      updatedAt: new Date(),
      updatedBy: null,
    });
    return this.settings.save(this.seal(created));
  }
}
