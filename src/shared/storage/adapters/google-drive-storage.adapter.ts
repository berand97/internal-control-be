import { createHash } from 'node:crypto';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { StorageDriver } from '../../../config/configuration.js';
import { parseDriveFolderId } from '../parse-drive-folder-id.js';
import type {
  PutObjectInput,
  StoragePort,
  StoredObject,
} from '../storage.port.js';

export interface GoogleDriveAdapterConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly folderId: string | null;
}

interface TokenResponse {
  readonly access_token?: unknown;
}

const readAccessToken = async (
  config: GoogleDriveAdapterConfig,
): Promise<string> => {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new ApiException(ErrorCode.StorageOauthFailed);
  }
  const payload = (await response.json()) as TokenResponse;
  if (typeof payload.access_token !== 'string') {
    throw new ApiException(ErrorCode.StorageOauthFailed);
  }
  return payload.access_token;
};

export class GoogleDriveStorageAdapter implements StoragePort {
  readonly driver: StorageDriver = 'google_drive';

  constructor(private readonly config: GoogleDriveAdapterConfig) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    const token = await readAccessToken(this.config);
    const metadata: Record<string, unknown> = {
      name: input.key.replaceAll('/', '_'),
    };
    const folderId = parseDriveFolderId(this.config.folderId) ?? null;
    if (folderId) {
      metadata['parents'] = [folderId];
    }
    const boundary = `unac-${Date.now()}`;
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${input.contentType}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([prefix, input.body, suffix]);
    const response = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!response.ok) {
      throw new ApiException(
        ErrorCode.StorageUnavailable,
        folderId
          ? 'Google Drive rechazó la carpeta. Usa solo el ID (el tramo después de /folders/), no el nombre ni la URL, y vuelve a conectar Drive.'
          : undefined,
      );
    }
    const created = (await response.json()) as { id?: unknown };
    const externalId = typeof created.id === 'string' ? created.id : null;
    return {
      key: input.key,
      driver: this.driver,
      contentType: input.contentType,
      byteSize: input.body.byteLength,
      checksumSha256: createHash('sha256').update(input.body).digest('hex'),
      externalId,
    };
  }

  async get(key: string): Promise<Buffer> {
    const token = await readAccessToken(this.config);
    const fileId = await this.findFileId(token, key);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const token = await readAccessToken(this.config);
    const fileId = await this.findFileId(token, key);
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const token = await readAccessToken(this.config);
      await this.findFileId(token, key);
      return true;
    } catch {
      return false;
    }
  }

  async presignGet(key: string): Promise<string> {
    const token = await readAccessToken(this.config);
    const fileId = await this.findFileId(token, key);
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  private async findFileId(token: string, key: string): Promise<string> {
    const name = key.replaceAll('/', '_');
    const query = encodeURIComponent(`name='${name.replaceAll("'", "\\'")}' and trashed=false`);
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new ApiException(ErrorCode.StorageUnavailable);
    }
    const payload = (await response.json()) as { files?: unknown };
    const files = Array.isArray(payload.files) ? payload.files : [];
    const first = files[0];
    if (
      typeof first === 'object' &&
      first !== null &&
      typeof (first as { id?: unknown }).id === 'string'
    ) {
      return (first as { id: string }).id;
    }
    throw new ApiException(ErrorCode.ResourceNotFound);
  }
}
