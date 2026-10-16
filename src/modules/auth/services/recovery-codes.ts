import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 3;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUPS * GROUP_LENGTH;
const CANONICAL = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_ENTROPY_BITS = CODE_LENGTH * 5;

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

export const normalizeRecoveryCode = (input: string): string | null => {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CANONICAL.test(canonical) ? canonical : null;
};
