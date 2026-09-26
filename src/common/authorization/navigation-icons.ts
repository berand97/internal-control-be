/**
 * Catálogo cerrado de íconos del menú (columna navigation_item.icon). Cada clave es el nombre kebab-case de un
 * ícono de Lucide (https://lucide.dev/icons/<clave>); el frontend traduce la clave al componente.
 *
 * - Los catorce primeros son los que el sidebar deducía del recurso (RESOURCE_ICONS en
 *   frontend/src/app/core/layout/sidebar/sidebar.component.ts) y `circle` es su fallback para recursos sin ícono.
 * - `mail`, `file-spreadsheet`, `upload`, `package-check` y `hand-helping` se añaden para correo, importación y
 *   entregas.
 *
 * La base de datos lo refuerza con el CHECK ck_navigation_item_icon (migración 1767225740000). Añadir una clave
 * exige una migración que amplíe ese CHECK; el test de integración navigation-menu compara ambos.
 */
export const NAVIGATION_ICONS = [
  'users',
  'shield',
  'map-pinned',
  'landmark',
  'wallet',
  'tags',
  'package',
  'handshake',
  'file-text',
  'hard-drive',
  'clipboard-check',
  'calculator',
  'panels-top-left',
  'list-tree',
  'circle',
  'mail',
  'file-spreadsheet',
  'upload',
  'package-check',
  'hand-helping',
] as const;

export type NavigationIcon = (typeof NAVIGATION_ICONS)[number];

export const isNavigationIcon = (value: unknown): value is NavigationIcon =>
  typeof value === 'string' && (NAVIGATION_ICONS as ReadonlyArray<string>).includes(value);
