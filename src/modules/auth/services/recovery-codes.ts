import { randomBytes } from 'node:crypto';

/** Alfabeto Crockford Base32: sin I, L, O ni U para que se lea y se dicte sin ambigüedad. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 3;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUPS * GROUP_LENGTH;
const CANONICAL = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export const RECOVERY_CODE_COUNT = 10;
/** 12 símbolos de 32 posibles = 60 bits de entropía por código. */
export const RECOVERY_CODE_ENTROPY_BITS = CODE_LENGTH * 5;

/** Código legible `XXXX-XXXX-XXXX`. 256 es múltiplo de 32, así que `byte & 31` no introduce sesgo. */
export const generateRecoveryCode = (): string => {
  const bytes = randomBytes(CODE_LENGTH);
  const symbols = Array.from(bytes, (byte) => ALPHABET[byte & 31]).join('');
  const groups: string[] = [];
  for (let start = 0; start < CODE_LENGTH; start += GROUP_LENGTH) {
    groups.push(symbols.slice(start, start + GROUP_LENGTH));
  }
  return groups.join('-');
};

export const generateRecoveryCodes = (): ReadonlyArray<string> =>
  Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

/**
 * Forma canónica sobre la que se calcula y se verifica el hash: sin guiones ni espacios, en mayúsculas, con las
 * confusiones Crockford (O→0, I/L→1). Devuelve null si no puede ser un código de recuperación.
 */
export const normalizeRecoveryCode = (input: string): string | null => {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CANONICAL.test(canonical) ? canonical : null;
};
