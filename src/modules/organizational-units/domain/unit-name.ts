import { normalizeText } from '../org-chart/org-chart.types.js';

/**
 * Nombres de unidades: no son únicos en la base (dos «Calidad» bajo la Rectoría, con prefijos 102 y 103, son válidas),
 * pero dos hermanas con el mismo nombre suelen ser un duplicado. Se comparan sin tildes, sin mayúsculas y con los
 * espacios compactados (normalizeText).
 */

export const sameUnitName = (left: string, right: string): boolean => normalizeText(left) === normalizeText(right);

/** «bajo Rectoría» o, sin jefe, «en el primer nivel». */
export const unitPlace = (parentName: string | null): string => (parentName ? `bajo ${parentName}` : 'en el primer nivel');

/** «Ya existe «Calidad» bajo Rectoría (prefijo 102)» con las notas que haya (prefijo, creación…). */
export const existingSiblingText = (
  sibling: { readonly name: string; readonly codePrefix: string | null },
  parentName: string | null,
  notes: ReadonlyArray<string> = [],
): string => {
  const details = [sibling.codePrefix ? `prefijo ${sibling.codePrefix}` : null, ...notes].filter(
    (item): item is string => Boolean(item),
  );
  return `Ya existe «${sibling.name}» ${unitPlace(parentName)}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
};

/** Advertencia (no error) al crear o editar una unidad con el nombre de una hermana activa. */
export const duplicateSiblingWarning = (
  sibling: { readonly name: string; readonly codePrefix: string | null },
  parentName: string | null,
): string =>
  `${existingSiblingText(sibling, parentName)}. ¿Es otra unidad? Si es así, use un nombre que las distinga.`;
