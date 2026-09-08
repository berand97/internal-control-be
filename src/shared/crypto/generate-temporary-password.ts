import { randomInt } from 'node:crypto';

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*?';
const ALPHABET = `${LOWER}${UPPER}${DIGITS}${SYMBOLS}`;
const DEFAULT_LENGTH = 16;

const pick = (source: string): string => {
  const char = source.charAt(randomInt(source.length));
  return char === '' ? 'A' : char;
};

const shuffle = (chars: ReadonlyArray<string>): string[] => {
  const items = [...chars];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = items[index];
    const swapped = items[swapIndex];
    if (current === undefined || swapped === undefined) {
      continue;
    }
    items[index] = swapped;
    items[swapIndex] = current;
  }
  return items;
};

export const generateTemporaryPassword = (
  length = DEFAULT_LENGTH,
): string => {
  const size = Math.max(length, 12);
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: size - required.length }, () =>
    pick(ALPHABET),
  );
  return shuffle([...required, ...rest]).join('');
};
