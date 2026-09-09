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

export interface FeaturesConfig {
  readonly circuitThreshold: number;
  readonly overrides: Readonly<Record<string, boolean>>;
}

export interface AppConfig {
  readonly port: number;
  readonly appPublicUrl: string;
  readonly apiPublicUrl: string;
  readonly database: DatabaseConfig;
  readonly jwt: JwtConfig;
  readonly argon2: Argon2Config;
  readonly refreshCookie: RefreshCookieConfig;
  readonly cors: CorsConfig;
  readonly storage: StorageConfig;
  readonly movementSigningSecret: string;
  readonly settingsEncryptionKey: string;
  readonly features: FeaturesConfig;
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

const readBoolean = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1';
};

const FEATURE_ENV_PREFIX = 'FEATURE_';
const RESERVED_FEATURE_ENV = new Set(['FEATURE_CIRCUIT_THRESHOLD']);

const readFeatureOverrides = (): Readonly<Record<string, boolean>> => {
  const overrides: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith(FEATURE_ENV_PREFIX) || RESERVED_FEATURE_ENV.has(key)) {
      continue;
    }
    if (raw === undefined || raw === '') {
      continue;
    }
    const code = key
      .slice(FEATURE_ENV_PREFIX.length)
      .toLowerCase()
      .replace(/_/g, '-');
    overrides[code] = raw === 'true' || raw === '1';
  }
  return overrides;
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

const configuration = (): AppConfig => ({
  port: readNumber('PORT', 3000),
  appPublicUrl: readString('APP_PUBLIC_URL', 'http://localhost:4200'),
  apiPublicUrl: readString('API_PUBLIC_URL', 'http://localhost:3000'),
  database: {
    url: readRequiredString('DATABASE_URL'),
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
    qrSecret: readString('QR_SIGNING_SECRET', readRequiredString('JWT_ACCESS_SECRET')),
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
  movementSigningSecret: readString(
    'MOVEMENT_SIGNING_SECRET',
    readRequiredString('JWT_ACCESS_SECRET'),
  ),
  settingsEncryptionKey: readString(
    'SETTINGS_ENCRYPTION_KEY',
    readRequiredString('JWT_ACCESS_SECRET'),
  ),
  features: {
    circuitThreshold: readNumber('FEATURE_CIRCUIT_THRESHOLD', 5),
    overrides: readFeatureOverrides(),
  },
});

export default configuration;
