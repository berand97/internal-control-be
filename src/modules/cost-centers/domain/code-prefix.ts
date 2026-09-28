/**
 * Códigos de centro de costo (plan de centros de Contabilidad, hoja «2025» de docs/centros de costo.xlsx): un dígito
 * para la raíz de una vicerrectoría (1, 2, 4, 5, 9) y cuatro dígitos por debajo (X000 → XY00 → XYnn; algunos
 * subgrupos XYZ0 → XYZn, p. ej. 3050 → 3051–3053). El prefijo de una unidad son los dígitos iniciales de su rango.
 */

/** Largo de los códigos de detalle del plan (X000–X999). */
export const DETAIL_CODE_LENGTH = 4;

const DIGITS = /^[0-9]+$/;

export const isDetailCode = (code: string): boolean => code.length === DETAIL_CODE_LENGTH && DIGITS.test(code);

export const isRootCode = (code: string): boolean => code.length === 1 && DIGITS.test(code);

export const codeMatchesPrefix = (code: string, prefix: string): boolean => code.startsWith(prefix);

/** Rango de códigos de detalle de un prefijo: 4 → 4000–4999; 43 → 4300–4399. */
export const prefixRange = (prefix: string): { readonly from: string; readonly to: string } => ({
  from: prefix.padEnd(DETAIL_CODE_LENGTH, '0'),
  to: prefix.padEnd(DETAIL_CODE_LENGTH, '9'),
});

export const prefixRangeMessage = (unitName: string, prefix: string): string => {
  const range = prefixRange(prefix);
  return `Los centros de ${unitName} van de ${range.from} a ${range.to} (el código debe empezar por ${prefix})`;
};

/**
 * Candidatos a centro padre de un código, en orden, cuando el archivo no trae columna de padre:
 * XYZ0 (si no es el propio código; solo sirve si es agrupador), XY00, X000 y X. Un código de un dígito es raíz; uno que
 * no es de cuatro dígitos no tiene padre derivable. No se usan los nombres (9206–9211 quedan bajo 9200 aunque su
 * nombre diga «FONDO PARA EL DESARROLLO DEL PERSONAL», como 9205).
 */
export interface ParentCandidate {
  readonly code: string;
  /** El candidato solo vale si es un nodo agrupador (sin movimiento). */
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

/**
 * Primer candidato que existe (en el archivo o en la base). isGrouping dice si un código existente es agrupador;
 * devuelve undefined si el código no existe.
 */
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

/** Prefijo más largo, entre los dados, con que empieza el código. */
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
  /** Por qué no hay código (rango lleno); null si hay sugerencia. */
  readonly reason: string | null;
}

const pad = (value: number): string => String(value).padStart(DETAIL_CODE_LENGTH, '0');

/**
 * Siguiente código libre entre candidatos ordenados: el que sigue al mayor usado; si el mayor ya es el último, el
 * primer hueco.
 */
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

/**
 * Código sugerido bajo un centro padre: bajo X, X000; bajo XY00 (o X000), el siguiente XYnn libre (XY01–XY99); bajo un
 * subgrupo XYZ0 con Z distinto de 0, el siguiente XYZn (XYZ1–XYZ9).
 */
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

/**
 * Código sugerido en el rango de una unidad, sin padre: un bloque del primer nivel bajo el prefijo (4 → 4100, 4200…;
 * 43 → 4310, 4320…; 431 → 4311…), el siguiente al mayor usado.
 */
export const suggestInPrefix = (prefix: string, used: ReadonlySet<string>): CodeSuggestion => {
  const { from, to } = prefixRange(prefix);
  const step = 10 ** Math.max(DETAIL_CODE_LENGTH - prefix.length - 1, 0);
  const candidates = range(Number(from) + step, Number(to), step);
  const code = prefix.length >= DETAIL_CODE_LENGTH ? (used.has(prefix) ? null : prefix) : nextFree(candidates, used);
  return { code, rangeFrom: from, rangeTo: to, reason: code ? null : `No quedan códigos libres entre ${from} y ${to}` };
};
