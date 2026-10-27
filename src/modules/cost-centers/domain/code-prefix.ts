export const DETAIL_CODE_LENGTH = 4;

const DIGITS = /^[0-9]+$/;

export const isDetailCode = (code: string): boolean => code.length === DETAIL_CODE_LENGTH && DIGITS.test(code);

export const isRootCode = (code: string): boolean => code.length === 1 && DIGITS.test(code);

export const codeMatchesPrefix = (code: string, prefix: string): boolean => code.startsWith(prefix);

export const prefixRange = (prefix: string): { readonly from: string; readonly to: string } => ({
  from: prefix.padEnd(DETAIL_CODE_LENGTH, '0'),
  to: prefix.padEnd(DETAIL_CODE_LENGTH, '9'),
});

export const prefixRangeMessage = (unitName: string, prefix: string): string => {
  const range = prefixRange(prefix);
  return `Los centros de ${unitName} van de ${range.from} a ${range.to}. Use un código que empiece por ${prefix}.`;
};

export interface ParentCandidate {
  readonly code: string;
  readonly mustBeGrouping: boolean;
}

export const parentCandidates = (code: string): ReadonlyArray<ParentCandidate> => {
  if (!isDetailCode(code)) {
    return [];
  }
  const candidates: ParentCandidate[] = [
    { code: `${code.slice(0, 3)}0`, mustBeGrouping: true },
    { code: `${code.slice(0, 2)}00`, mustBeGrouping: false },
    { code: `${code.slice(0, 1)}000`, mustBeGrouping: false },
    { code: code.slice(0, 1), mustBeGrouping: false },
  ];
  const seen = new Set<string>([code]);
  return candidates.filter((candidate) => {
    if (seen.has(candidate.code)) {
      return false;
    }
    seen.add(candidate.code);
    return true;
  });
};

export const deriveParentCode = (
  code: string,
  isGrouping: (candidate: string) => boolean | undefined,
): string | null => {
  for (const candidate of parentCandidates(code)) {
    const grouping = isGrouping(candidate.code);
    if (grouping === undefined) {
      continue;
    }
    if (candidate.mustBeGrouping && !grouping) {
      continue;
    }
    return candidate.code;
  }
  return null;
};

export const longestPrefix = <T extends { readonly codePrefix: string }>(
  code: string,
  units: ReadonlyArray<T>,
): T | undefined =>
  units
    .filter((unit) => codeMatchesPrefix(code, unit.codePrefix))
    .sort((left, right) => right.codePrefix.length - left.codePrefix.length)[0];

export interface CodeSuggestion {
  readonly code: string | null;
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly reason: string | null;
}

const pad = (value: number): string => String(value).padStart(DETAIL_CODE_LENGTH, '0');

const nextFree = (candidates: ReadonlyArray<string>, used: ReadonlySet<string>): string | null => {
  let lastUsed = -1;
  candidates.forEach((candidate, index) => {
    if (used.has(candidate)) {
      lastUsed = index;
    }
  });
  const after = candidates.slice(lastUsed + 1).find((candidate) => !used.has(candidate));
  return after ?? candidates.find((candidate) => !used.has(candidate)) ?? null;
};

const range = (from: number, to: number, step: number): string[] => {
  const values: string[] = [];
  for (let value = from; value <= to; value += step) {
    values.push(pad(value));
  }
  return values;
};

export const suggestUnderParent = (parentCode: string, used: ReadonlySet<string>): CodeSuggestion => {
  if (isRootCode(parentCode)) {
    const code = `${parentCode}000`;
    return used.has(code)
      ? { code: null, rangeFrom: code, rangeTo: code, reason: `${code} ya existe` }
      : { code, rangeFrom: code, rangeTo: code, reason: null };
  }
  if (!isDetailCode(parentCode)) {
    return { code: null, rangeFrom: '', rangeTo: '', reason: `El código del padre (${parentCode}) no es de cuatro dígitos` };
  }
  const subgroup = parentCode[2] !== '0' && parentCode[3] === '0';
  const base = Number(subgroup ? parentCode.slice(0, 3) : parentCode.slice(0, 2));
  const candidates = subgroup ? range(base * 10 + 1, base * 10 + 9, 1) : range(base * 100 + 1, base * 100 + 99, 1);
  const code = nextFree(candidates, used);
  const rangeFrom = candidates[0] ?? '';
  const rangeTo = candidates[candidates.length - 1] ?? '';
  return { code, rangeFrom, rangeTo, reason: code ? null : `No quedan códigos libres entre ${rangeFrom} y ${rangeTo}` };
};

export const suggestInPrefix = (prefix: string, used: ReadonlySet<string>): CodeSuggestion => {
  const { from, to } = prefixRange(prefix);
  const step = 10 ** Math.max(DETAIL_CODE_LENGTH - prefix.length - 1, 0);
  const candidates = range(Number(from) + step, Number(to), step);
  const code = prefix.length >= DETAIL_CODE_LENGTH ? (used.has(prefix) ? null : prefix) : nextFree(candidates, used);
  return { code, rangeFrom: from, rangeTo: to, reason: code ? null : `No quedan códigos libres entre ${from} y ${to}` };
};
