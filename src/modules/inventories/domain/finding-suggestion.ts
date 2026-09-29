/**
 * Sugerencia de categoría de hallazgo a partir del catálogo (inventory_finding_category). Solo sugiere: el auditor
 * fija la categoría. Reglas, todas en datos:
 * - participan las categorías activas;
 * - una categoría aplica si cumple TODOS sus criterios no nulos: el resultado del ítem está en suggestResults y la
 *   condición observada está en suggestConditions; sin ningún criterio, nunca aplica;
 * - si aplican varias, gana la que acierta por condición observada (es más específica que el resultado), luego la
 *   de más criterios y luego la de menor sortOrder / código.
 */

export interface SuggestibleCategory {
  readonly code: string;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly suggestResults: ReadonlyArray<string> | null;
  readonly suggestConditions: ReadonlyArray<string> | null;
}

export interface SuggestibleItem {
  readonly result: string;
  readonly actualCondition: string | null;
}

const score = (category: SuggestibleCategory, item: SuggestibleItem): number | null => {
  const byResult = category.suggestResults !== null && category.suggestResults.length > 0;
  const byCondition = category.suggestConditions !== null && category.suggestConditions.length > 0;
  if (!byResult && !byCondition) {
    return null;
  }
  if (byResult && !category.suggestResults?.includes(item.result)) {
    return null;
  }
  if (byCondition && (item.actualCondition === null || !category.suggestConditions?.includes(item.actualCondition))) {
    return null;
  }
  return (byCondition ? 2 : 0) + (byResult ? 1 : 0);
};

export const suggestFindingCategory = (
  categories: ReadonlyArray<SuggestibleCategory>,
  item: SuggestibleItem,
): string | null => {
  let best: { readonly code: string; readonly score: number; readonly sortOrder: number } | null = null;
  for (const category of categories) {
    if (!category.isActive) {
      continue;
    }
    const value = score(category, item);
    if (value === null) {
      continue;
    }
    const better =
      best === null ||
      value > best.score ||
      (value === best.score &&
        (category.sortOrder < best.sortOrder ||
          (category.sortOrder === best.sortOrder && category.code < best.code)));
    if (better) {
      best = { code: category.code, score: value, sortOrder: category.sortOrder };
    }
  }
  return best?.code ?? null;
};
