import { createHash } from 'node:crypto';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { StorageDriver } from '../../../config/configuration.js';
import type {
  PutObjectInput,
  StoragePort,
  StoredObject,
} from '../storage.port.js';

export interface OneDriveAdapterConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly folderId: string | null;
}

const readAccessToken = async (
  config: OneDriveAdapterConfig,
): Promise<string> => {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access Files.ReadWrite',
  });
  const tenant = config.tenantId || 'common';
  const response = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!response.ok) {
    throw new ApiException(ErrorCode.StorageOauthFailed);
  }
  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string') {
    throw new ApiException(ErrorCode.StorageOauthFailed);
  }
  return payload.access_token;
};

const itemPath = (config: OneDriveAdapterConfig, key: string): string => {
  const folder = config.folderId ? `${config.folderId}/` : '';
  return `root:/${folder}${key}`.replaceAll('//', '/');
};

export class OneDriveStorageAdapter implements StoragePort {
  readonly driver: StorageDriver = 'onedrive';

  constructor(private readonly config: OneDriveAdapterConfig) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    const token = await readAccessToken(this.config);
    const path = itemPath(this.config, input.key);
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/${path}:/content`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': input.contentType,
        },
        body: Uint8Array.from(input.body),
      },
    );
    if (!response.ok) {
      throw new ApiException(ErrorCode.StorageUnavailable);
    }
    const created = (await response.json()) as { id?: unknown };
    return {
      key: input.key,
      driver: this.driver,
      contentType: input.contentType,
      byteSize: input.body.byteLength,
      checksumSha256: createHash('sha256').update(input.body).digest('hex'),
      externalId: typeof created.id === 'string' ? created.id : null,
    };
  }

  async get(key: string): Promise<Buffer> {
    const token = await readAccessToken(this.config);
    const path = itemPath(this.config, key);
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/${path}:/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const token = await readAccessToken(this.config);
    const path = itemPath(this.config, key);
    await fetch(`https://graph.microsoft.com/v1.0/me/drive/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const token = await readAccessToken(this.config);
      const path = itemPath(this.config, key);
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/${path}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async presignGet(key: string): Promise<string> {
    const token = await readAccessToken(this.config);
    const path = itemPath(this.config, key);
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const payload = (await response.json()) as {
      '@microsoft.graph.downloadUrl'?: unknown;
    };
    if (typeof payload['@microsoft.graph.downloadUrl'] === 'string') {
      return payload['@microsoft.graph.downloadUrl'];
    }
    throw new ApiException(ErrorCode.StorageUnavailable);
  }
}
