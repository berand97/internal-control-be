import { normalizeText } from '../org-chart/org-chart.types.js';

export const sameUnitName = (left: string, right: string): boolean => normalizeText(left) === normalizeText(right);

export const unitPlace = (parentName: string | null): string => (parentName ? `en ${parentName}` : 'en el primer nivel');

export const existingSiblingText = (
  sibling: { readonly name: string },
  parentName: string | null,
  notes: ReadonlyArray<string> = [],
): string => `Ya existe ${sibling.name} ${unitPlace(parentName)}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;

export const duplicateSiblingError = (sibling: { readonly name: string }, parentName: string | null): string =>
  `${existingSiblingText(sibling, parentName)}.`;

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
