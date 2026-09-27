/**
 * Claves propias de cada propósito (BE-12). Antes, si faltaban, las tres caían en JWT_ACCESS_SECRET: una sola
 * fuga comprometía la autenticación, la integridad de los movimientos, los QR impresos y los secretos cifrados,
 * y rotar el secreto JWT rompía todo lo anterior.
 *
 * - Fuera de producción se conserva el valor por defecto (JWT_ACCESS_SECRET) para no romper entornos locales.
 * - En producción las tres son obligatorias, no pueden ser iguales a JWT_ACCESS_SECRET ni a JWT_REFRESH_SECRET ni
 *   quedar con el texto de ejemplo. El backend no arranca si no se cumple (igual que SIGNATURE_VERIFY_URL).
 * - MOVEMENT_SIGNING_SECRET_PREVIOUS y SETTINGS_ENCRYPTION_KEY_PREVIOUS (lista separada por comas) permiten rotar:
 *   con la anterior se siguen verificando firmas y descifrando secretos ya guardados. Ver docs/DEPLOY.md.
 */
export interface DedicatedSecrets {
  readonly qrSecret: string;
  readonly movementSigningSecret: string;
  readonly movementSigningPreviousSecrets: ReadonlyArray<string>;
  readonly settingsEncryptionKey: string;
  readonly settingsEncryptionPreviousKeys: ReadonlyArray<string>;
}

type Env = Readonly<Record<string, string | undefined>>;

const PLACEHOLDER = /^reemplazar/i;

const value = (env: Env, key: string): string | undefined => {
  const raw = env[key]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
};

const list = (env: Env, key: string): ReadonlyArray<string> =>
  (env[key] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

const DEDICATED = ['QR_SIGNING_SECRET', 'MOVEMENT_SIGNING_SECRET', 'SETTINGS_ENCRYPTION_KEY'] as const;
const PREVIOUS = ['MOVEMENT_SIGNING_SECRET_PREVIOUS', 'SETTINGS_ENCRYPTION_KEY_PREVIOUS'] as const;

const assertProductionSecrets = (env: Env): void => {
  const jwt = new Map<string, string>();
  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const current = value(env, name);
    if (current !== undefined) {
      jwt.set(current, name);
    }
  }
  const missing = DEDICATED.filter((name) => value(env, name) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} es obligatoria en producción: cada propósito necesita su propia clave (ya no se usa JWT_ACCESS_SECRET). ` +
        'Si la instalación ya estaba en uso sin ella, su valor efectivo era el de JWT_ACCESS_SECRET: fíjela con ese valor y rote JWT_ACCESS_SECRET. Ver docs/DEPLOY.md',
    );
  }
  for (const name of DEDICATED) {
    const current = value(env, name) ?? '';
    if (PLACEHOLDER.test(current)) {
      throw new Error(`${name} conserva el valor de ejemplo de .env.example. Ver docs/DEPLOY.md`);
    }
    const clash = jwt.get(current);
    if (clash) {
      throw new Error(`${name} no puede ser igual a ${clash}: use una clave propia. Ver docs/DEPLOY.md`);
    }
  }
  for (const name of PREVIOUS) {
    for (const previous of list(env, name)) {
      const clash = jwt.get(previous);
      if (clash) {
        throw new Error(
          `${name} contiene el valor actual de ${clash}: rote ${clash} antes de desplegar. Ver docs/DEPLOY.md`,
        );
      }
    }
  }
};

export const resolveDedicatedSecrets = (env: Env): DedicatedSecrets => {
  if (env['NODE_ENV'] === 'production') {
    assertProductionSecrets(env);
  }
  const legacy = (): string => {
    const jwt = value(env, 'JWT_ACCESS_SECRET');
    if (jwt === undefined) {
      throw new Error('Variable de entorno requerida ausente: JWT_ACCESS_SECRET');
    }
    return jwt;
  };
  return {
    qrSecret: value(env, 'QR_SIGNING_SECRET') ?? legacy(),
    movementSigningSecret: value(env, 'MOVEMENT_SIGNING_SECRET') ?? legacy(),
    movementSigningPreviousSecrets: list(env, 'MOVEMENT_SIGNING_SECRET_PREVIOUS'),
    settingsEncryptionKey: value(env, 'SETTINGS_ENCRYPTION_KEY') ?? legacy(),
    settingsEncryptionPreviousKeys: list(env, 'SETTINGS_ENCRYPTION_KEY_PREVIOUS'),
  };
};

/**
 * Advertencias de producción que no impiden arrancar: una instalación existente puede tener las tres claves con el
 * mismo valor heredado (el antiguo JWT_ACCESS_SECRET) hasta completar la rotación documentada.
 */
export const dedicatedSecretWarnings = (env: Env): ReadonlyArray<string> => {
  if (env['NODE_ENV'] !== 'production') {
    return [];
  }
  const values = DEDICATED.map((name) => [name, value(env, name)] as const);
  const warnings: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      const [leftName, left] = values[i] ?? [];
      const [rightName, right] = values[j] ?? [];
      if (left !== undefined && left === right) {
        warnings.push(`${leftName} y ${rightName} comparten valor: rótelas por separado (docs/DEPLOY.md)`);
      }
    }
  }
  return warnings;
};
