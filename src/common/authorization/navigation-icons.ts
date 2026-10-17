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
