export const UNIT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export const UNIT_COLOR_MESSAGE = 'El color debe tener el formato #RRGGBB, por ejemplo #DE9927';

export const normalizeUnitColorInput = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
};

export const parseUnitColor = (text: string): string | undefined => {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return match ? `#${(match[1] ?? '').toLowerCase()}` : undefined;
};

interface ColoredUnit {
  readonly id: string;
  readonly parentId: string | null;
  readonly color: string | null;
}

export const effectiveUnitColor = (
  unit: ColoredUnit,
  byId: ReadonlyMap<string, ColoredUnit>,
): string | null => {
  const seen = new Set<string>();
  let current: ColoredUnit | undefined = unit;
  while (current && !seen.has(current.id)) {
    if (current.color) {
      return current.color;
    }
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
};
