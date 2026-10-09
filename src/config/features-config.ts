/**
 * Módulos del sistema (src/modules/features). Se valida al arrancar: un valor fuera de rango detiene el backend con el
 * motivo.
 */
export interface FeaturesConfig {
  /** Errores internos (5xx) que abren el circuito de un módulo (FEATURE_CIRCUIT_THRESHOLD). */
  readonly circuitThreshold: number;
  /**
   * Cada cuánto la caché de módulos se relee completa desde la BD, además del NOTIFY (FEATURE_FLAGS_RELOAD_SECONDS;
   * 0 = solo NOTIFY). Solo en el proceso HTTP.
   */
  readonly reloadIntervalMs: number;
  /** FEATURE_<CODIGO>=true|false fija un módulo por entorno. */
  readonly overrides: Readonly<Record<string, boolean>>;
}

export const DEFAULT_FEATURE_CIRCUIT_THRESHOLD = 5;
export const DEFAULT_FEATURE_FLAGS_RELOAD_SECONDS = 30;

const FEATURE_ENV_PREFIX = 'FEATURE_';
/** Variables FEATURE_* que son ajustes y no kill-switch de un módulo. */
const RESERVED_FEATURE_ENV = new Set(['FEATURE_CIRCUIT_THRESHOLD', 'FEATURE_FLAGS_RELOAD_SECONDS']);

type Env = Readonly<Record<string, string | undefined>>;

const readNumber = (env: Env, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Variable de entorno no numérica: ${key}`);
  }
  return parsed;
};

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
  circuitThreshold: readNumber(env, 'FEATURE_CIRCUIT_THRESHOLD', DEFAULT_FEATURE_CIRCUIT_THRESHOLD),
  reloadIntervalMs:
    readIntegerInRange(env, 'FEATURE_FLAGS_RELOAD_SECONDS', DEFAULT_FEATURE_FLAGS_RELOAD_SECONDS, 0, 3600) * 1000,
  overrides: readFeatureOverrides(env),
});
