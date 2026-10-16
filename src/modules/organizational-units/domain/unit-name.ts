import { normalizeText } from '../org-chart/org-chart.types.js';

export const sameUnitName = (left: string, right: string): boolean => normalizeText(left) === normalizeText(right);

export const unitPlace = (parentName: string | null): string => (parentName ? `bajo ${parentName}` : 'en el primer nivel');

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

export const duplicateSiblingWarning = (
  sibling: { readonly name: string; readonly codePrefix: string | null },
  parentName: string | null,
): string =>
  `${existingSiblingText(sibling, parentName)}. ¿Es otra unidad? Si es así, use un nombre que las distinga.`;
