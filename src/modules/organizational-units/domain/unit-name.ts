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

export const DUPLICATE_SIBLING_HINT = 'Dos unidades activas bajo la misma dependencia no pueden llamarse igual: use un nombre que las distinga.';

export const duplicateSiblingError = (
  sibling: { readonly name: string; readonly codePrefix: string | null },
  parentName: string | null,
): string => `${existingSiblingText(sibling, parentName)}. ${DUPLICATE_SIBLING_HINT}`;

export const duplicateSiblingGroups = <T extends { readonly code: string; readonly name: string; readonly parentId: string | null }>(
  units: ReadonlyArray<T>,
): ReadonlyArray<ReadonlyArray<T>> => {
  const groups = new Map<string, T[]>();
  for (const unit of [...units].sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))) {
    const key = `${unit.parentId ?? ''}|${normalizeText(unit.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), unit]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
};
