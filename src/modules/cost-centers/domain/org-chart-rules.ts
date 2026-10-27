import { isDetailCode, longestPrefix } from './code-prefix.js';

export const expectedParentCode = (code: string): string | null => {
  if (!isDetailCode(code)) {
    return null;
  }
  const last = code[3];
  if (last === '0' || last === '5') {
    return null;
  }
  return `${code.slice(0, 3)}0`;
};

export interface CenterParentResolution {
  readonly parentCode: string | null;
  readonly missingParentCode: string | null;
}

export const resolveCenterParent = (code: string, exists: (candidate: string) => boolean): CenterParentResolution => {
  const expected = expectedParentCode(code);
  if (expected === null) {
    return { parentCode: null, missingParentCode: null };
  }
  return exists(expected)
    ? { parentCode: expected, missingParentCode: null }
    : { parentCode: null, missingParentCode: expected };
};

export const resolveCenterUnit = <T extends { readonly codePrefix: string }>(
  code: string,
  units: ReadonlyArray<T>,
): T | undefined => longestPrefix(code, units);

export const normalizeUnitPrefix = (raw: string): string => {
  if (!/^[0-9]{4}$/.test(raw)) {
    return raw;
  }
  return raw.replace(/0+$/, '') || raw;
};

export const childPrefixError = (childPrefix: string, ancestorPrefix: string | null): string | null => {
  if (ancestorPrefix === null) {
    return null;
  }
  if (childPrefix.startsWith(ancestorPrefix) && childPrefix.length > ancestorPrefix.length) {
    return null;
  }
  if (childPrefix.startsWith(ancestorPrefix)) {
    return `El prefijo ${childPrefix} es el mismo de su jefe. Agregue al menos un dígito.`;
  }
  return `El prefijo ${childPrefix} no empieza por ${ancestorPrefix}, el de su jefe.`;
};

export interface PrefixCheck {
  readonly level: 'OK' | 'WARNING' | 'ERROR';
  readonly message: string | null;
}

export interface PrefixCheckNames {
  readonly child?: string | null;
  readonly ancestor?: string | null;
}

export const checkUnitPrefix = (
  childPrefix: string,
  ancestorPrefix: string | null,
  otherActivePrefixes: ReadonlyMap<string, string>,
  ancestorChain: ReadonlySet<string> = new Set(),
  names: PrefixCheckNames = {},
): PrefixCheck => {
  const message = childPrefix.length === 1 ? null : childPrefixError(childPrefix, ancestorPrefix);
  if (!message || ancestorPrefix === null) {
    return { level: 'OK', message: null };
  }
  if (childPrefix.startsWith(ancestorPrefix)) {
    return { level: 'ERROR', message };
  }
  const owner = [...otherActivePrefixes.keys()]
    .filter(
      (prefix) =>
        prefix !== ancestorPrefix &&
        !ancestorChain.has(prefix) &&
        prefix.length < childPrefix.length &&
        childPrefix.startsWith(prefix),
    )
    .sort((left, right) => right.length - left.length)[0];
  const child = names.child ?? 'La dependencia';
  const boss = names.ancestor ?? 'su jefe';
  const ownerName = owner ? otherActivePrefixes.get(owner) : undefined;
  return {
    level: 'WARNING',
    message: ownerName
      ? `${child} quedó bajo ${boss}, pero su prefijo ${childPrefix} es de la rama de ${ownerName}.`
      : `${child} quedó bajo ${boss}, pero su prefijo ${childPrefix} no empieza por ${ancestorPrefix}.`,
  };
};

export interface OrgChartCodeSuggestion {
  readonly fixedPrefix: string;
  readonly code: string | null;
  readonly candidates: ReadonlyArray<string>;
}

const firstFree = (candidates: ReadonlyArray<string>, used: ReadonlySet<string>): string | null =>
  candidates.find((candidate) => !used.has(candidate)) ?? null;

export const suggestUnderGroupCenter = (parentCode: string, used: ReadonlySet<string>): OrgChartCodeSuggestion | null => {
  if (!isDetailCode(parentCode) || parentCode[3] !== '0' || parentCode[2] === '0') {
    return null;
  }
  const fixedPrefix = parentCode.slice(0, 3);
  const candidates = ['1', '2', '3', '4', '6', '7', '8', '9'].map((digit) => `${fixedPrefix}${digit}`);
  return { fixedPrefix, code: firstFree(candidates, used), candidates };
};

export const suggestForUnitPrefix = (prefix: string, used: ReadonlySet<string>): OrgChartCodeSuggestion => {
  let candidates: string[];
  if (prefix.length === 1) {
    candidates = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => `${prefix}0${digit}0`);
  } else if (prefix.length === 2) {
    candidates = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => `${prefix}${digit}0`);
  } else if (prefix.length === 3) {
    candidates = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => `${prefix}${digit}`);
  } else {
    candidates = [prefix];
  }
  return { fixedPrefix: prefix, code: firstFree(candidates, used), candidates };
};

export interface UnitPrefixSuggestion {
  readonly fixedPrefix: string;
  readonly suggested: string | null;
  readonly taken: ReadonlyArray<string>;
}

export const suggestUnitPrefix = (ancestorPrefix: string | null, takenPrefixes: ReadonlySet<string>): UnitPrefixSuggestion => {
  const fixedPrefix = ancestorPrefix ?? '';
  const candidates = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => `${fixedPrefix}${digit}`);
  const taken = candidates.filter((candidate) => takenPrefixes.has(candidate));
  return { fixedPrefix, suggested: firstFree(candidates, takenPrefixes), taken };
};

export const pendingHeadCenterMessage = (code: string, archived: boolean): string =>
  archived
    ? `El centro ${code} está archivado. Quedará como centro propio cuando lo reactiven.`
    : `El centro ${code} aún no existe. Quedará como centro propio cuando lo creen.`;
