import { isDetailCode, longestPrefix } from './code-prefix.js';

/**
 * Reglas del organigrama para los códigos de centro de costo (lista de Contabilidad sin X000/XY00: todos los centros
 * son de cuatro dígitos y todos con movimiento).
 *
 * - Prefijo de 1 dígito X: rectoría o vicerrectoría; de 2 dígitos XY: un cuadro del organigrama.
 * - Unidad de un centro: la unidad activa con el prefijo más largo con que empieza el código (2523 → «25»; 4351 → «43»;
 *   9228 → «9» si no hay «92»).
 * - Padre de un centro XYZn:
 *   - n = 0 (XYZ0): sin centro padre, cuelga de su unidad.
 *   - n = 5 (XYZ5): sin centro padre. En la Vicerrectoría Financiera los centros van de 5 en 5 (4110, 4115, 4120…) y
 *     son hermanos, no hijos.
 *   - otro n: XYZ0 si existe (4351 → 4350). Si no existe (3051–3053 sin 3050) queda sin padre, en su unidad, y se
 *     reporta como «código que no cuadra»; nunca se rechaza por eso.
 *
 * Reemplaza a parentCandidates/deriveParentCode (code-prefix.ts) para el organigrama. Esas siguen solo en la
 * importación COST_CENTERS con structureMode=UPDATE_STRUCTURE (hoja «2025», con agrupadores X000/XY00).
 */

/** Centro padre que el código pide por regla (XYZ0), o null si no pide ninguno. */
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
  /** Código del centro padre que le corresponde y existe; null: cuelga de su unidad. */
  readonly parentCode: string | null;
  /** El padre que pide la regla y no existe (para «códigos que no cuadran»); null si no falta ninguno. */
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

/** Unidad de un centro por su código: la de prefijo más largo. */
export const resolveCenterUnit = <T extends { readonly codePrefix: string }>(
  code: string,
  units: ReadonlyArray<T>,
): T | undefined => longestPrefix(code, units);

/**
 * Prefijo de una unidad hija respecto del prefijo de su ancestro más cercano con prefijo: debe empezar por él y tener
 * exactamente un dígito más (1 → 2 dígitos; 2 → 3 si alguien lo necesita). Sin ancestro con prefijo, cualquier
 * prefijo vale. Devuelve el mensaje de error en español, o null si es válido.
 */
export const childPrefixError = (childPrefix: string, ancestorPrefix: string | null): string | null => {
  if (ancestorPrefix === null) {
    return null;
  }
  if (childPrefix.startsWith(ancestorPrefix) && childPrefix.length === ancestorPrefix.length + 1) {
    return null;
  }
  return `El prefijo ${childPrefix} no cuadra con el de la unidad de la que depende (${ancestorPrefix}): debe ser ${ancestorPrefix} seguido de un dígito (${ancestorPrefix}0–${ancestorPrefix}9)`;
};

export interface PrefixCheck {
  readonly level: 'OK' | 'WARNING' | 'ERROR';
  readonly message: string | null;
}

/**
 * Regla jerárquica con una excepción para el organigrama real: si el prefijo no empieza por el del ancestro pero
 * ninguna otra unidad activa es dueña de sus dígitos iniciales (30 bajo la Académica «2» cuando no existe la unidad
 * «3»: los centros 30xx son de la Académica), se acepta con advertencia. Si otra unidad lo es (53 bajo «4» con la
 * unidad «5»), es error. Un prefijo de un dígito (vicerrectoría bajo la Rectoría «1») siempre vale.
 */
export const checkUnitPrefix = (
  childPrefix: string,
  ancestorPrefix: string | null,
  otherActivePrefixes: ReadonlySet<string>,
): PrefixCheck => {
  // Un dígito = rectoría o vicerrectoría: su bloque de códigos no depende del de la Rectoría de la que cuelga.
  const message = childPrefix.length === 1 ? null : childPrefixError(childPrefix, ancestorPrefix);
  if (!message) {
    return { level: 'OK', message: null };
  }
  const owner = [...otherActivePrefixes]
    .filter((prefix) => prefix.length < childPrefix.length && childPrefix.startsWith(prefix))
    .sort((left, right) => right.length - left.length)[0];
  if (owner) {
    return { level: 'ERROR', message: `${message}; los códigos que empiezan por ${owner} son de otra unidad` };
  }
  return {
    level: 'WARNING',
    message: `El prefijo ${childPrefix} no empieza por el de la unidad de la que depende (${ancestorPrefix ?? ''}); se acepta porque ninguna otra unidad tiene sus dígitos iniciales`,
  };
};

export interface OrgChartCodeSuggestion {
  /** Parte fija del código (el front la muestra bloqueada). */
  readonly fixedPrefix: string;
  /** Siguiente código libre; null si no queda ninguno. */
  readonly code: string | null;
  /** Candidatos en orden (para mostrar el rango). */
  readonly candidates: ReadonlyArray<string>;
}

const firstFree = (candidates: ReadonlyArray<string>, used: ReadonlySet<string>): string | null =>
  candidates.find((candidate) => !used.has(candidate)) ?? null;

/** Hijo de un centro XYZ0 (Z ≠ 0): XYZ1–XYZ9 sin XYZ5 (XYZ5 es hermano, no hijo). null si el padre no es XYZ0. */
export const suggestUnderGroupCenter = (parentCode: string, used: ReadonlySet<string>): OrgChartCodeSuggestion | null => {
  if (!isDetailCode(parentCode) || parentCode[3] !== '0' || parentCode[2] === '0') {
    return null;
  }
  const fixedPrefix = parentCode.slice(0, 3);
  const candidates = ['1', '2', '3', '4', '6', '7', '8', '9'].map((digit) => `${fixedPrefix}${digit}`);
  return { fixedPrefix, code: firstFree(candidates, used), candidates };
};

/**
 * Centro de una unidad por su prefijo: X → X010, X020… (los centros propios de la rectoría o vicerrectoría van en
 * X0Z0); XY → XY10, XY20…; XYZ → XYZ0, XYZ1…; XYZW → él mismo.
 */
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

/**
 * Prefijo de una unidad nueva bajo un ancestro con prefijo p: p seguido de un dígito 1–9 (p0 queda para los centros
 * propios del ancestro). Sin ancestro con prefijo: un dígito 1–9.
 */
export const suggestUnitPrefix = (ancestorPrefix: string | null, takenPrefixes: ReadonlySet<string>): UnitPrefixSuggestion => {
  const fixedPrefix = ancestorPrefix ?? '';
  const candidates = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => `${fixedPrefix}${digit}`);
  const taken = candidates.filter((candidate) => takenPrefixes.has(candidate));
  return { fixedPrefix, suggested: firstFree(candidates, takenPrefixes), taken };
};
