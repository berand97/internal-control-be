import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import jwt from 'jsonwebtoken';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type {
  AppConfig,
  S3Provider,
  StorageConfig,
  StorageDriver,
} from '../../config/configuration.js';
import { GoogleDriveStorageAdapter } from './adapters/google-drive-storage.adapter.js';
import { OneDriveStorageAdapter } from './adapters/onedrive-storage.adapter.js';
import { ProjectStorageAdapter } from './adapters/project-storage.adapter.js';
import { S3StorageAdapter } from './adapters/s3-storage.adapter.js';
import { StorageSettings } from './entities/storage-settings.entity.js';
import { parseDriveFolderId } from './parse-drive-folder-id.js';
import type { PutObjectInput, StoragePort, StoredObject } from './storage.port.js';

interface OauthState {
  readonly typ: 'storage-oauth';
  readonly provider: 'google_drive' | 'onedrive';
  readonly userId: string;
}

const isOauthState = (value: unknown): value is OauthState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['typ'] === 'storage-oauth' &&
    (record['provider'] === 'google_drive' || record['provider'] === 'onedrive') &&
    typeof record['userId'] === 'string'
  );
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

@Injectable()
export class StorageService {
  constructor(
    @InjectRepository(StorageSettings)
    private readonly settings: Repository<StorageSettings>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    return (await this.resolveAdapter()).put(input);
  }

  async get(key: string): Promise<Buffer> {
    return (await this.resolveAdapter()).get(key);
  }

  async getFrom(driver: StorageDriver, key: string): Promise<Buffer> {
    return (await this.resolveAdapter(driver)).get(key);
  }

  async delete(key: string): Promise<void> {
    return (await this.resolveAdapter()).delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.resolveAdapter()).exists(key);
  }

  async presignGet(key: string, expiresInSeconds = 3600): Promise<string> {
    return (await this.resolveAdapter()).presignGet(key, expiresInSeconds);
  }

  async status(userId?: string): Promise<{
    readonly driver: StorageDriver;
    readonly projectPath: string;
    readonly s3Provider: S3Provider;
    readonly s3Endpoint: string | null;
    readonly s3Region: string;
    readonly s3Bucket: string | null;
    readonly googleConnected: boolean;
    readonly onedriveConnected: boolean;
    readonly googleClientId: string | null;
    readonly googleFolderId: string | null;
    readonly onedriveClientId: string | null;
    readonly needsOauth: boolean;
    readonly authorizationUrl: string | null;
  }> {
    const resolved = await this.resolvedConfig();
    const needsOauth =
      (resolved.driver === 'google_drive' && !resolved.google.refreshToken) ||
      (resolved.driver === 'onedrive' && !resolved.onedrive.refreshToken);
    let authorizationUrl: string | null = null;
    if (needsOauth && userId) {
      const provider =
        resolved.driver === 'google_drive' ? 'google_drive' : 'onedrive';
      const hasClient =
        provider === 'google_drive'
          ? Boolean(resolved.google.clientId)
          : Boolean(resolved.onedrive.clientId);
      if (hasClient) {
        authorizationUrl = await this.oauthStartUrl(provider, userId);
      }
    }
    return {
      driver: resolved.driver,
      projectPath: resolved.projectPath,
      s3Provider: resolved.s3.provider,
      s3Endpoint: resolved.s3.endpoint,
      s3Region: resolved.s3.region,
      s3Bucket: resolved.s3.bucket,
      googleConnected: Boolean(resolved.google.refreshToken),
      onedriveConnected: Boolean(resolved.onedrive.refreshToken),
      googleClientId: mask(resolved.google.clientId),
      googleFolderId: resolved.google.folderId,
      onedriveClientId: mask(resolved.onedrive.clientId),
      needsOauth,
      authorizationUrl,
    };
  }

  async testConnection(): Promise<{ readonly ok: true; readonly driver: StorageDriver }> {
    const adapter = await this.resolveAdapter();
    const key = `health/${Date.now()}.txt`;
    await adapter.put({
      key,
      body: Buffer.from('ok'),
      contentType: 'text/plain',
    });
    await adapter.delete(key);
    return { ok: true, driver: adapter.driver };
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
    const row = await this.requireRow();
    const nextDriver = patch.driver ?? row.driver;
    const nextGoogleId = patch.googleClientId ?? row.googleClientId;
    const nextGoogleSecret = patch.googleClientSecret ?? row.googleClientSecret;
    const nextOnedriveId = patch.onedriveClientId ?? row.onedriveClientId;
    const nextOnedriveSecret = patch.onedriveClientSecret ?? row.onedriveClientSecret;
    if (nextDriver === 'google_drive' && (!nextGoogleId || !nextGoogleSecret)) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        'Falta Client ID y Client Secret de Google',
      );
    }
    if (nextDriver === 'onedrive' && (!nextOnedriveId || !nextOnedriveSecret)) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        'Falta Client ID y Client Secret de OneDrive',
      );
    }
    if (patch.driver !== undefined) {
      row.driver = patch.driver;
    }
    if (patch.projectPath !== undefined) {
      row.projectPath = patch.projectPath;
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
    await this.settings.save(row);
  }

  async oauthStartUrl(
    provider: 'google_drive' | 'onedrive',
    userId: string,
  ): Promise<string> {
    const resolved = await this.resolvedConfig();
    const state = jwt.sign(
      { typ: 'storage-oauth', provider, userId } satisfies OauthState,
      this.config.getOrThrow('jwt.accessSecret', { infer: true }),
      { expiresIn: '10m' },
    );
    const redirectUri = `${this.config.getOrThrow('apiPublicUrl', { infer: true })}/api/v1/storage/oauth/${provider === 'google_drive' ? 'google' : 'onedrive'}/callback`;
    if (provider === 'google_drive') {
      const clientId = resolved.google.clientId;
      if (!clientId) {
        throw new ApiException(
          ErrorCode.StorageNotConfigured,
          'Guarda googleClientId y googleClientSecret con PATCH /api/v1/storage/settings antes de conectar Google',
        );
      }
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/drive.file',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }
    const clientId = resolved.onedrive.clientId;
    const tenant = resolved.onedrive.tenantId || 'common';
    if (!clientId) {
      throw new ApiException(
        ErrorCode.StorageNotConfigured,
        'Guarda onedriveClientId y onedriveClientSecret con PATCH /api/v1/storage/settings antes de conectar OneDrive',
      );
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: 'offline_access Files.ReadWrite',
      state,
    });
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async oauthCallback(
    provider: 'google_drive' | 'onedrive',
    code: string,
    state: string,
  ): Promise<void> {
    const decoded = jwt.verify(
      state,
      this.config.getOrThrow('jwt.accessSecret', { infer: true }),
    );
    if (!isOauthState(decoded) || decoded.provider !== provider) {
      throw new ApiException(ErrorCode.StorageOauthFailed);
    }
    const resolved = await this.resolvedConfig();
    const redirectUri = `${this.config.getOrThrow('apiPublicUrl', { infer: true })}/api/v1/storage/oauth/${provider === 'google_drive' ? 'google' : 'onedrive'}/callback`;
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
    row.updatedBy = decoded.userId;
    await this.settings.save(row);
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
      return new S3StorageAdapter({
        provider: resolved.s3.provider,
        endpoint: resolved.s3.endpoint,
        region: resolved.s3.region,
        bucket: resolved.s3.bucket,
        accessKey: resolved.s3.accessKey,
        secretKey: resolved.s3.secretKey,
        forcePathStyle: resolved.s3.forcePathStyle,
      });
    }
    if (resolved.driver === 'google_drive') {
      if (!resolved.google.clientId || !resolved.google.clientSecret) {
        throw new ApiException(
          ErrorCode.StorageNotConfigured,
          'Falta Client ID y Client Secret de Google',
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
        'Falta Client ID y Client Secret de OneDrive',
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
    const row = await this.settings.find({ take: 1 }).then((rows) => rows[0]);
    if (!row) {
      return env;
    }
    return {
      driver: row.driver || env.driver,
      projectPath: row.projectPath || env.projectPath,
      s3: {
        provider: row.s3Provider ?? env.s3.provider,
        endpoint: row.s3Endpoint ?? env.s3.endpoint,
        region: row.s3Region || env.s3.region,
        bucket: row.s3Bucket ?? env.s3.bucket,
        accessKey: row.s3AccessKey ?? env.s3.accessKey,
        secretKey: row.s3SecretKey ?? env.s3.secretKey,
        forcePathStyle: row.s3ForcePathStyle ?? env.s3.forcePathStyle,
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
    return this.settings.save(created);
  }
}
