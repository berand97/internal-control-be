import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { StorageDriver } from '../../../config/configuration.js';
import { resolveInsideRoot } from '../storage-key.js';
import type {
  PutObjectInput,
  StoragePort,
  StoredObject,
} from '../storage.port.js';

export class ProjectStorageAdapter implements StoragePort {
  readonly driver: StorageDriver = 'project';
  private readonly rootDir: string;

  constructor(
    rootDir: string,
    private readonly apiPublicUrl: string,
  ) {
    this.rootDir = path.resolve(rootDir);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const absolute = this.resolveKey(input.key);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, input.body);
    return {
      key: input.key,
      driver: this.driver,
      contentType: input.contentType,
      byteSize: input.body.byteLength,
      checksumSha256: createHash('sha256').update(input.body).digest('hex'),
      externalId: null,
    };
  }

  async get(key: string): Promise<Buffer> {
    const absolute = this.resolveKey(key);
    try {
      return await readFile(absolute);
    } catch {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const absolute = this.resolveKey(key);
    try {
      await stat(absolute);
      return true;
    } catch {
      return false;
    }
  }

  async presignGet(key: string): Promise<string> {
    this.resolveKey(key);
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.apiPublicUrl}/api/v1/storage/objects/${encoded}`;
  }

  private resolveKey(key: string): string {
    return resolveInsideRoot(this.rootDir, key);
  }
}
