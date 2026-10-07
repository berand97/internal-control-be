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
