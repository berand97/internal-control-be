/**
 * Color base de una rama del organigrama: cada unidad puede tener uno (#rrggbb, en minúsculas); el frontend pinta sus
 * dependencias con tonos más suaves del mismo color. Sin color propio, la unidad hereda el de su jefe más cercano que
 * tenga uno (effectiveColor).
 */

/** Formato guardado (y CHECK chk_org_unit_color de la base): # y seis dígitos hexadecimales en minúsculas. */
export const UNIT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export const UNIT_COLOR_MESSAGE = 'El color debe tener el formato #RRGGBB, por ejemplo #DE9927';

/** Lo que llega por la API: texto sin espacios al borde y en minúsculas; '' es null; el resto, tal cual (lo valida el DTO). */
export const normalizeUnitColorInput = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
};

/** Color escrito en el Excel (#DE9927 o DE9927, sin importar mayúsculas) → #de9927; undefined si no es un color. */
export const parseUnitColor = (text: string): string | undefined => {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return match ? `#${(match[1] ?? '').toLowerCase()}` : undefined;
};

interface ColoredUnit {
  readonly id: string;
  readonly parentId: string | null;
  readonly color: string | null;
}

/** Color propio o el del ancestro más cercano que tenga uno; null si nadie en la cadena tiene. A prueba de ciclos. */
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
