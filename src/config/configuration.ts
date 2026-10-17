import { Logger } from '@nestjs/common';
import {
  DEFAULT_TRUST_PROXY,
  parseTrustProxy,
  type TrustProxySetting,
} from '../common/http/trust-proxy.js';
import { DEFAULT_THROTTLE_USER_LIMIT } from '../common/throttling/throttle-limits.js';
import { guardDatabaseUrl } from './database-host-guard.js';
import { dedicatedSecretWarnings, resolveDedicatedSecrets } from './dedicated-secrets.js';
import { type EventsConfig, resolveEventsConfig } from './events-config.js';
import { type FeaturesConfig, resolveFeaturesConfig } from './features-config.js';
import { resolveGotenbergUrl } from './gotenberg-url.js';
import { resolveSignatureVerifyUrl } from './signature-verify-url.js';
import { normalizePublicAssetsBaseUrl, normalizePublicAssetsBucket } from '../shared/storage/public-assets.js';

export interface DatabaseConfig {
  readonly url: string;
  readonly logging: boolean;
}

export interface JwtConfig {
  readonly accessSecret: string;
  readonly accessExpiresInSeconds: number;
  readonly refreshSecret: string;
  readonly refreshExpiresInSeconds: number;
  readonly mfaChallengeExpiresInSeconds: number;
  readonly qrSecret: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface Argon2Config {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export interface RefreshCookieConfig {
  readonly secure: boolean;
}

export interface CorsConfig {
  readonly allowedOrigins: ReadonlyArray<string>;
}

export type StorageDriver =
  | 'project'
  | 's3'
  | 'google_drive'
  | 'onedrive';

export type S3Provider =
  | 'aws'
  | 'minio'
  | 'digitalocean'
  | 'cloudflare'
  | 'custom';

export interface StorageConfig {
  readonly driver: StorageDriver;
  readonly projectPath: string;
  readonly s3: {
    readonly provider: S3Provider;
    readonly endpoint: string | null;
    readonly region: string;
    readonly bucket: string | null;
    readonly accessKey: string | null;
    readonly secretKey: string | null;
    readonly forcePathStyle: boolean;
    readonly publicAssetsBucket: string | null;
    readonly publicAssetsBaseUrl: string | null;
  };
  readonly google: {
    readonly clientId: string | null;
    readonly clientSecret: string | null;
    readonly refreshToken: string | null;
    readonly folderId: string | null;
  };
  readonly onedrive: {
    readonly tenantId: string | null;
    readonly clientId: string | null;
    readonly clientSecret: string | null;
    readonly refreshToken: string | null;
    readonly folderId: string | null;
  };
}

export interface AppConfig {
  readonly port: number;
  readonly appPublicUrl: string;
  readonly apiPublicUrl: string;
  readonly apiDocsEnabled: boolean;
  readonly trustProxy: TrustProxySetting;
  readonly throttleUserLimit: number;
  readonly database: DatabaseConfig;
  readonly jwt: JwtConfig;
  readonly argon2: Argon2Config;
  readonly refreshCookie: RefreshCookieConfig;
  readonly cors: CorsConfig;
  readonly storage: StorageConfig;
  readonly movementSigningSecret: string;
  readonly movementSigningPreviousSecrets: ReadonlyArray<string>;
  readonly settingsEncryptionKey: string;
  readonly settingsEncryptionPreviousKeys: ReadonlyArray<string>;
  readonly outbound: OutboundConfig;
  readonly features: FeaturesConfig;
  readonly documents: DocumentsConfig;
  readonly emailBrand: EmailBrandConfig;
  readonly inventories: InventoriesConfig;
  readonly events: EventsConfig;
}

export interface InventoriesConfig {
  readonly weeklyConcentrationThreshold: number | null;
}

export interface OutboundConfig {
  readonly allowPrivateNetworks: boolean;
  readonly allowedHosts: ReadonlyArray<string>;
}

export interface EmailBrandConfig {
  readonly name: string;
  readonly logoUrl: string | null;
}

export type DocumentNumberingPolicy = 'continue' | 'restart';

export type SignatureProviderName = 'internal' | 'stub';

export interface DocumentsConfig {
  readonly gotenbergUrl: string | null;
  readonly numberingPolicy: DocumentNumberingPolicy;
  readonly signatureProvider: SignatureProviderName;
  readonly signatureVerifyUrl: string;
}

const DURATION_PATTERN = /^(\d+)([smhd])?$/;

export const parseDurationToSeconds = (value: string): number => {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(
      `Duración inválida: ${value}. Use segundos (900) o sufijos s, m, h, d (15m, 7d).`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const unitSeconds: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return amount * (unitSeconds[unit] ?? 1);
};

const readString = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const readRequiredString = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Variable de entorno requerida ausente: ${key}`);
  }
  return value;
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Variable de entorno no numérica: ${key}`);
  }
  return parsed;
};

const readOptionalPositiveInteger = (key: string): number | null => {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} debe ser un entero mayor o igual a 1 (recibido: ${raw})`);
  }
  return parsed;
};

const readBoolean = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1';
};

const readStorageDriver = (): StorageDriver => {
  const raw = readString('STORAGE_DRIVER', 'project');
  if (
    raw === 'project' ||
    raw === 's3' ||
    raw === 'google_drive' ||
    raw === 'onedrive'
  ) {
    return raw;
  }
  throw new Error(`STORAGE_DRIVER inválido: ${raw}`);
};

const readS3Provider = (): S3Provider => {
  const raw = readString('STORAGE_S3_PROVIDER', 'minio');
  if (
    raw === 'aws' ||
    raw === 'minio' ||
    raw === 'digitalocean' ||
    raw === 'cloudflare' ||
    raw === 'custom'
  ) {
    return raw;
  }
  throw new Error(`STORAGE_S3_PROVIDER inválido: ${raw}`);
};

const readNumberingPolicy = (): DocumentNumberingPolicy => {
  const raw = readString('DOCUMENT_NUMBERING_POLICY', 'continue');
  if (raw === 'continue' || raw === 'restart') {
    return raw;
  }
  throw new Error(`DOCUMENT_NUMBERING_POLICY inválido: ${raw}`);
};

const readSignatureProvider = (): SignatureProviderName => {
  const raw = readString('SIGNATURE_PROVIDER', 'internal');
  if (raw === 'internal' || raw === 'stub') {
    return raw;
  }
  throw new Error(`SIGNATURE_PROVIDER inválido: ${raw}`);
};

const readList = (key: string): ReadonlyArray<string> =>
  readString(key, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

const readPublicAssetsBucket = (): string | null => {
  const raw = readString('STORAGE_S3_PUBLIC_ASSETS_BUCKET', '').trim();
  return raw === '' ? null : normalizePublicAssetsBucket(raw);
};

const readPublicAssetsBaseUrl = (): string | null => {
  const raw = readString('STORAGE_S3_PUBLIC_ASSETS_BASE_URL', '').trim();
  return raw === '' ? null : normalizePublicAssetsBaseUrl(raw, process.env['NODE_ENV'] === 'production');
};

const readBrandLogoUrl = (): string | null => {
  const raw = readString('MAIL_BRAND_LOGO_URL', '').trim();
  if (raw === '') {
    return null;
  }
  try {
    if (new URL(raw).protocol === 'https:' && !/\s/.test(raw)) {
      return raw;
    }
  } catch {
  }
  new Logger('Config').warn('MAIL_BRAND_LOGO_URL no es un URL https válido; los correos muestran el nombre de la marca');
  return null;
};

const configuration = (): AppConfig => {
  const signatureVerifyUrl = resolveSignatureVerifyUrl(process.env);
  const gotenbergUrl = resolveGotenbergUrl(process.env);
  const secrets = resolveDedicatedSecrets(process.env);
  for (const warning of dedicatedSecretWarnings(process.env)) {
    new Logger('Config').warn(warning);
  }
  return {
    port: readNumber('PORT', 3000),
    appPublicUrl: readString('APP_PUBLIC_URL', 'http://localhost:4200'),
    apiPublicUrl: readString('API_PUBLIC_URL', 'http://localhost:3000'),
    apiDocsEnabled: readBoolean('API_DOCS_ENABLED', process.env['NODE_ENV'] !== 'production'),
    trustProxy: parseTrustProxy(readString('TRUST_PROXY', DEFAULT_TRUST_PROXY)),
    throttleUserLimit: readOptionalPositiveInteger('THROTTLE_USER_LIMIT') ?? DEFAULT_THROTTLE_USER_LIMIT,
    database: {
      url: guardDatabaseUrl(readRequiredString('DATABASE_URL'), process.env, (message) =>
        new Logger('Database').warn(message),
      ),
      logging: readBoolean('DATABASE_LOGGING', false),
    },
    jwt: {
      accessSecret: readRequiredString('JWT_ACCESS_SECRET'),
      accessExpiresInSeconds: parseDurationToSeconds(
        readString('JWT_ACCESS_EXPIRES_IN', '15m'),
      ),
      refreshSecret: readRequiredString('JWT_REFRESH_SECRET'),
      refreshExpiresInSeconds: parseDurationToSeconds(
        readString('JWT_REFRESH_EXPIRES_IN', '7d'),
      ),
      mfaChallengeExpiresInSeconds: parseDurationToSeconds(
        readString('JWT_MFA_CHALLENGE_EXPIRES_IN', '5m'),
      ),
      qrSecret: secrets.qrSecret,
      issuer: readString('JWT_ISSUER', 'asset-management-api'),
      audience: readString('JWT_AUDIENCE', 'asset-management-web'),
    },
    argon2: {
      memoryCost: readNumber('ARGON2_MEMORY_COST', 65536),
      timeCost: readNumber('ARGON2_TIME_COST', 3),
      parallelism: readNumber('ARGON2_PARALLELISM', 4),
    },
    refreshCookie: {
      secure: readBoolean('REFRESH_COOKIE_SECURE', true),
    },
    cors: {
      allowedOrigins: readString('CORS_ALLOWED_ORIGINS', '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    },
    storage: {
      driver: readStorageDriver(),
      projectPath: readString('STORAGE_PROJECT_PATH', 'storage'),
      s3: {
        provider: readS3Provider(),
        endpoint: readString('STORAGE_S3_ENDPOINT', '') || null,
        region: readString('STORAGE_S3_REGION', 'us-east-1'),
        bucket: readString('STORAGE_S3_BUCKET', '') || null,
        accessKey: readString('STORAGE_S3_ACCESS_KEY', '') || null,
        secretKey: readString('STORAGE_S3_SECRET_KEY', '') || null,
        forcePathStyle: readBoolean('STORAGE_S3_FORCE_PATH_STYLE', true),
        publicAssetsBucket: readPublicAssetsBucket(),
        publicAssetsBaseUrl: readPublicAssetsBaseUrl(),
      },
      google: {
        clientId: readString('STORAGE_GOOGLE_CLIENT_ID', '') || null,
        clientSecret: readString('STORAGE_GOOGLE_CLIENT_SECRET', '') || null,
        refreshToken: readString('STORAGE_GOOGLE_REFRESH_TOKEN', '') || null,
        folderId: readString('STORAGE_GOOGLE_FOLDER_ID', '') || null,
      },
      onedrive: {
        tenantId: readString('STORAGE_ONEDRIVE_TENANT_ID', '') || null,
        clientId: readString('STORAGE_ONEDRIVE_CLIENT_ID', '') || null,
        clientSecret: readString('STORAGE_ONEDRIVE_CLIENT_SECRET', '') || null,
        refreshToken: readString('STORAGE_ONEDRIVE_REFRESH_TOKEN', '') || null,
        folderId: readString('STORAGE_ONEDRIVE_FOLDER_ID', '') || null,
      },
    },
    movementSigningSecret: secrets.movementSigningSecret,
    movementSigningPreviousSecrets: secrets.movementSigningPreviousSecrets,
    settingsEncryptionKey: secrets.settingsEncryptionKey,
    settingsEncryptionPreviousKeys: secrets.settingsEncryptionPreviousKeys,
    outbound: {
      allowPrivateNetworks: readBoolean(
        'OUTBOUND_ALLOW_PRIVATE_NETWORKS',
        process.env['NODE_ENV'] !== 'production',
      ),
      allowedHosts: readList('OUTBOUND_ALLOWED_HOSTS'),
    },
    features: resolveFeaturesConfig(process.env),
    documents: {
      signatureVerifyUrl,
      gotenbergUrl,
      numberingPolicy: readNumberingPolicy(),
      signatureProvider: readSignatureProvider(),
    },
    emailBrand: {
      name: readString('MAIL_BRAND_NAME', 'Control Interno UNAC').trim(),
      logoUrl: readBrandLogoUrl(),
    },
    inventories: {
      weeklyConcentrationThreshold: readOptionalPositiveInteger('INVENTORY_WEEKLY_CONCENTRATION_THRESHOLD'),
    },
    events: resolveEventsConfig(process.env),
  };
};

export default configuration;
