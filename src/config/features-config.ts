
export interface FeaturesConfig {
  readonly circuitThreshold: number;
  readonly circuitWindowMs: number;
  readonly circuitCooldownMs: number;
  readonly reloadIntervalMs: number;
  readonly overrides: Readonly<Record<string, boolean>>;
}

export const DEFAULT_FEATURE_CIRCUIT_THRESHOLD = 5;
export const DEFAULT_FEATURE_CIRCUIT_WINDOW_SECONDS = 120;
export const DEFAULT_FEATURE_CIRCUIT_COOLDOWN_SECONDS = 300;
export const DEFAULT_FEATURE_FLAGS_RELOAD_SECONDS = 30;

const FEATURE_ENV_PREFIX = 'FEATURE_';
const RESERVED_FEATURE_ENV = new Set([
  'FEATURE_CIRCUIT_THRESHOLD',
  'FEATURE_CIRCUIT_WINDOW_SECONDS',
  'FEATURE_CIRCUIT_COOLDOWN_SECONDS',
  'FEATURE_FLAGS_RELOAD_SECONDS',
]);

type Env = Readonly<Record<string, string | undefined>>;

const readIntegerInRange = (env: Env, key: string, fallback: number, min: number, max: number): number => {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} debe ser un entero entre ${min} y ${max} (recibido: ${raw})`);
  }
  return parsed;
};

const readFeatureOverrides = (env: Env): Readonly<Record<string, boolean>> => {
  const overrides: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(FEATURE_ENV_PREFIX) || RESERVED_FEATURE_ENV.has(key)) {
      continue;
    }
    if (raw === undefined || raw === '') {
      continue;
    }
    const code = key.slice(FEATURE_ENV_PREFIX.length).toLowerCase().replace(/_/g, '-');
    overrides[code] = raw === 'true' || raw === '1';
  }
  return overrides;
};

export const resolveFeaturesConfig = (env: Env): FeaturesConfig => ({
  circuitThreshold: readIntegerInRange(env, 'FEATURE_CIRCUIT_THRESHOLD', DEFAULT_FEATURE_CIRCUIT_THRESHOLD, 1, 1000),
  circuitWindowMs:
    readIntegerInRange(env, 'FEATURE_CIRCUIT_WINDOW_SECONDS', DEFAULT_FEATURE_CIRCUIT_WINDOW_SECONDS, 1, 86_400) * 1000,
  circuitCooldownMs:
    readIntegerInRange(env, 'FEATURE_CIRCUIT_COOLDOWN_SECONDS', DEFAULT_FEATURE_CIRCUIT_COOLDOWN_SECONDS, 1, 86_400) *
    1000,
  reloadIntervalMs:
    readIntegerInRange(env, 'FEATURE_FLAGS_RELOAD_SECONDS', DEFAULT_FEATURE_FLAGS_RELOAD_SECONDS, 0, 3600) * 1000,
  overrides: readFeatureOverrides(env),
});
