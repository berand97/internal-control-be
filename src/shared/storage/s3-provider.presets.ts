import type { S3Provider } from '../../config/configuration.js';

export interface S3ProviderPreset {
  readonly forcePathStyle: boolean;
  readonly defaultEndpoint: (region: string) => string | null;
}

export const S3_PROVIDER_PRESETS: Record<S3Provider, S3ProviderPreset> = {
  aws: {
    forcePathStyle: false,
    defaultEndpoint: () => null,
  },
  minio: {
    forcePathStyle: true,
    defaultEndpoint: () => 'http://localhost:9000',
  },
  digitalocean: {
    forcePathStyle: false,
    defaultEndpoint: (region) => `https://${region}.digitaloceanspaces.com`,
  },
  cloudflare: {
    forcePathStyle: true,
    defaultEndpoint: () => null,
  },
  custom: {
    forcePathStyle: true,
    defaultEndpoint: () => null,
  },
};
