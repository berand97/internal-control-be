import type { StorageDriver } from '../../config/configuration.js';

export const STORAGE_PORT = 'StoragePort';

export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface StoredObject {
  readonly key: string;
  readonly driver: StorageDriver;
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly externalId: string | null;
}

export interface StoragePort {
  readonly driver: StorageDriver;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}

export const isStoragePort = (value: unknown): value is StoragePort => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['put'] === 'function' &&
    typeof record['get'] === 'function' &&
    typeof record['driver'] === 'string'
  );
};
