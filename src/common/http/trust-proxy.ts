import type { NestExpressApplication } from '@nestjs/platform-express';

export type TrustProxySetting = false | number | ReadonlyArray<string>;

export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export const parseTrustProxy = (raw: string): TrustProxySetting => {
  const value = raw.trim().toLowerCase();
  if (value === 'false' || value === '') {
    return false;
  }
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true confía en cualquier X-Forwarded-For; use el número de proxies o sus redes');
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

export const applyTrustProxy = (app: NestExpressApplication, setting: TrustProxySetting): void => {
  app.set('trust proxy', typeof setting === 'number' || setting === false ? setting : [...setting]);
};
