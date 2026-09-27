import { createHash } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { S3Provider, StorageDriver } from '../../../config/configuration.js';
import {
  assertHostShapeAllowed,
  guardedLookup,
  type OutboundPolicy,
} from '../../net/outbound-destination.js';
import { S3_PROVIDER_PRESETS } from '../s3-provider.presets.js';
import type {
  PutObjectInput,
  StoragePort,
  StoredObject,
} from '../storage.port.js';

export interface S3AdapterConfig {
  readonly provider: S3Provider;
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
}

const toBuffer = async (body: unknown): Promise<Buffer> => {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    const transformable = body as { transformToByteArray: () => Promise<Uint8Array> };
    return Buffer.from(await transformable.transformToByteArray());
  }
  throw new ApiException(ErrorCode.StorageUnavailable);
};

export class S3StorageAdapter implements StoragePort {
  readonly driver: StorageDriver = 's3';
  private readonly client: S3Client;

  /**
   * Con `outbound` (BE-16) el endpoint no puede apuntar a la red interna: la IP literal o el nombre interno se
   * rechazan aquí (OutboundDestinationError) y cada conexión resuelve el DNS a través de guardedLookup.
   */
  constructor(
    private readonly config: S3AdapterConfig,
    outbound?: OutboundPolicy,
  ) {
    const preset = S3_PROVIDER_PRESETS[config.provider];
    const endpoint = config.endpoint ?? preset.defaultEndpoint(config.region);
    if (outbound && endpoint) {
      let hostname: string;
      try {
        hostname = new URL(endpoint).hostname;
      } catch {
        throw new ApiException(ErrorCode.StorageNotConfigured, 'El endpoint S3 no es una URL válida');
      }
      assertHostShapeAllowed(hostname, outbound);
    }
    const lookup = outbound ? guardedLookup(outbound) : undefined;
    this.client = new S3Client({
      region: config.region,
      ...(endpoint ? { endpoint } : {}),
      ...(lookup
        ? {
            requestHandler: {
              httpAgent: new HttpAgent({ keepAlive: true, lookup }),
              httpsAgent: new HttpsAgent({ keepAlive: true, lookup }),
            },
          }
        : {}),
      forcePathStyle: config.forcePathStyle || preset.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    } catch {
      throw new ApiException(ErrorCode.StorageUnavailable);
    }
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
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return toBuffer(result.Body);
    } catch {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}
