import { isDetailCode, longestPrefix } from './code-prefix.js';

/**
 * Reglas del organigrama para los códigos de centro de costo (lista de Contabilidad sin X000/XY00: todos los centros
 * son de cuatro dígitos y todos con movimiento).
 *
 * - Prefijo de 1 dígito X: rectoría o vicerrectoría; de 2–4 dígitos: un cuadro del organigrama, que empieza por el
 *   prefijo de su jefe y es más largo (4 → 41 → 4115).
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
 * Prefijo escrito como código de Contabilidad: con 4 dígitos y ceros al final se toma sin ellos (1000 → 1; 1100 → 11;
 * 1210 → 121; 4110 → 411). Los de 1–3 dígitos y los de 4 sin cero final (4115) quedan igual.
 */
export const normalizeUnitPrefix = (raw: string): string => {
  if (!/^[0-9]{4}$/.test(raw)) {
    return raw;
  }
  return raw.replace(/0+$/, '') || raw;
};

/**
 * Prefijo de una unidad hija respecto del prefijo de su ancestro más cercano con prefijo (su jefe): debe empezar por él
 * y ser más largo (4 → 43; 41 → 4115; 12 → 121). Sin ancestro con prefijo, cualquier prefijo vale. Devuelve el mensaje
 * de error en español, o null si es válido.
 */
export const childPrefixError = (childPrefix: string, ancestorPrefix: string | null): string | null => {
  if (ancestorPrefix === null) {
    return null;
  }
  if (childPrefix.startsWith(ancestorPrefix) && childPrefix.length > ancestorPrefix.length) {
    return null;
  }
  if (childPrefix.startsWith(ancestorPrefix)) {
    return `El prefijo ${childPrefix} debe tener más dígitos que el de su jefe (${ancestorPrefix})`;
  }
  return `El prefijo ${childPrefix} no empieza por el de su jefe (${ancestorPrefix})`;
};

export interface PrefixCheck {
  readonly level: 'OK' | 'WARNING' | 'ERROR';
  readonly message: string | null;
}

/** Nombres para los mensajes de checkUnitPrefix (sin ellos: «La unidad», «su jefe»). */
export interface PrefixCheckNames {
  readonly child?: string | null;
  readonly ancestor?: string | null;
}

/**
 * Prefijo de una unidad frente al de su jefe (el ancestro más cercano con prefijo). El código manda: los centros van a
 * la unidad del prefijo más largo, así que una unidad que se mueve a otro jefe conserva sus números.
 *
 * - OK: empieza por el del jefe y es más largo (4 → 43), sin jefe con prefijo, o un dígito (vicerrectoría bajo la
 *   Rectoría «1»).
 * - WARNING (siempre): no empieza por el del jefe. «Control Interno (432) depende de Rectoría (1) pero conserva los
 *   códigos 432… de Contabilidad» cuando otra unidad activa es dueña de sus dígitos iniciales (el jefe y sus ancestros,
 *   ancestorChain, nunca cuentan como «otra unidad»).
 * - ERROR: el mismo prefijo de su jefe (duplicado). El duplicado con cualquier otra unidad activa lo rechaza el índice
 *   único de prefijos (ORG_UNIT_CODE_PREFIX_EXISTS) y el plan del Excel.
 *
 * otherActivePrefixes: prefijo → nombre de las demás unidades activas.
 */
export const checkUnitPrefix = (
  childPrefix: string,
  ancestorPrefix: string | null,
  otherActivePrefixes: ReadonlyMap<string, string>,
  ancestorChain: ReadonlySet<string> = new Set(),
  names: PrefixCheckNames = {},
): PrefixCheck => {
  // Un dígito = rectoría o vicerrectoría: su bloque de códigos no depende del de la Rectoría de la que cuelga.
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
  const child = `${names.child ?? 'La unidad'} (${childPrefix})`;
  const boss = names.ancestor ? `${names.ancestor} (${ancestorPrefix})` : `su jefe (${ancestorPrefix})`;
  return {
    level: 'WARNING',
    message: owner
      ? `${child} depende de ${boss} pero conserva los códigos ${childPrefix}… de ${otherActivePrefixes.get(owner) ?? 'otra unidad'}`
      : `${child} depende de ${boss} pero sus códigos ${childPrefix}… no empiezan por ${ancestorPrefix}`,
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

/** Advertencia de un centro propio escrito por código que todavía no se puede amarrar. */
export const pendingHeadCenterMessage = (code: string, archived: boolean): string =>
  archived
    ? `Centro propio ${code} pendiente: el centro está archivado; se amarrará solo cuando se reactive`
    : `Centro propio ${code} pendiente: el centro aún no existe; se amarrará solo cuando se cree`;
