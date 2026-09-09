export const FEATURE_DISABLED_REASONS = ['MANUAL', 'CIRCUIT', 'ENV'] as const;

export type FeatureDisabledReason = (typeof FEATURE_DISABLED_REASONS)[number];

export const API_GLOBAL_PREFIX = '/api/v1';

export interface FeatureDefinition {
  readonly code: string;
  readonly label: string;
  readonly core: boolean;
  readonly resourceTypes: ReadonlyArray<string>;
  readonly pathPrefixes: ReadonlyArray<string>;
}

export interface FeatureSnapshot {
  readonly code: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly core: boolean;
  readonly reason: FeatureDisabledReason | null;
  readonly resourceTypes: ReadonlyArray<string>;
}

export const FEATURE_CATALOG: ReadonlyArray<FeatureDefinition> = [
  {
    code: 'auth',
    label: 'Autenticación',
    core: true,
    resourceTypes: [],
    pathPrefixes: ['/auth'],
  },
  {
    code: 'roles',
    label: 'Roles y permisos',
    core: true,
    resourceTypes: ['role', 'navigation'],
    pathPrefixes: ['/roles', '/permissions', '/navigation'],
  },
  {
    code: 'users',
    label: 'Usuarios',
    core: true,
    resourceTypes: ['user'],
    pathPrefixes: ['/users'],
  },
  {
    code: 'features',
    label: 'Módulos del sistema',
    core: true,
    resourceTypes: ['feature'],
    pathPrefixes: ['/features'],
  },
  {
    code: 'campus',
    label: 'Campus',
    core: false,
    resourceTypes: ['campus'],
    pathPrefixes: ['/campus'],
  },
  {
    code: 'buildings',
    label: 'Edificios',
    core: false,
    resourceTypes: [],
    pathPrefixes: [],
  },
  {
    code: 'locations',
    label: 'Ubicaciones',
    core: false,
    resourceTypes: [],
    pathPrefixes: ['/locations'],
  },
  {
    code: 'organizational-units',
    label: 'Unidades organizacionales',
    core: false,
    resourceTypes: ['org_unit'],
    pathPrefixes: ['/organizational-units'],
  },
  {
    code: 'cost-centers',
    label: 'Centros de costo',
    core: false,
    resourceTypes: ['cost_center'],
    pathPrefixes: ['/cost-centers'],
  },
  {
    code: 'categories',
    label: 'Categorías',
    core: false,
    resourceTypes: ['category'],
    pathPrefixes: ['/categories'],
  },
  {
    code: 'dynamic-fields',
    label: 'Campos dinámicos',
    core: false,
    resourceTypes: [],
    pathPrefixes: [],
  },
  {
    code: 'assets',
    label: 'Activos',
    core: false,
    resourceTypes: ['asset'],
    pathPrefixes: ['/assets'],
  },
  {
    code: 'qr-tokens',
    label: 'Códigos QR',
    core: false,
    resourceTypes: [],
    pathPrefixes: ['/qr'],
  },
  {
    code: 'movements',
    label: 'Movimientos',
    core: false,
    resourceTypes: [],
    pathPrefixes: ['/movements'],
  },
  {
    code: 'loans',
    label: 'Préstamos',
    core: false,
    resourceTypes: ['loan'],
    pathPrefixes: ['/loans'],
  },
  {
    code: 'inventories',
    label: 'Tomas físicas',
    core: false,
    resourceTypes: ['physical_inventory'],
    pathPrefixes: ['/inventories'],
  },
  {
    code: 'depreciation',
    label: 'Depreciación',
    core: false,
    resourceTypes: ['depreciation'],
    pathPrefixes: ['/depreciation'],
  },
  {
    code: 'document-templates',
    label: 'Plantillas',
    core: false,
    resourceTypes: ['document_template'],
    pathPrefixes: ['/document-templates'],
  },
  {
    code: 'storage',
    label: 'Almacenamiento',
    core: false,
    resourceTypes: ['storage'],
    pathPrefixes: ['/storage'],
  },
  {
    code: 'mail',
    label: 'Correo',
    core: false,
    resourceTypes: ['mail'],
    pathPrefixes: ['/mail'],
  },
];

const FEATURE_BY_CODE = new Map(
  FEATURE_CATALOG.map((feature) => [feature.code, feature]),
);

export const findFeatureDefinition = (
  code: string,
): FeatureDefinition | undefined => FEATURE_BY_CODE.get(code);

export const isKnownFeatureCode = (code: string): boolean =>
  FEATURE_BY_CODE.has(code);

export const stripApiPrefix = (path: string): string => {
  const pathname = (path.split('?')[0] ?? path).replace(/\/+$/, '') || '/';
  if (pathname === API_GLOBAL_PREFIX) {
    return '/';
  }
  return pathname.startsWith(`${API_GLOBAL_PREFIX}/`)
    ? pathname.slice(API_GLOBAL_PREFIX.length)
    : pathname;
};

const pathMatchesPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export const featureCodesForPath = (path: string): ReadonlyArray<string> => {
  const pathname = stripApiPrefix(path);
  return FEATURE_CATALOG.filter((feature) =>
    feature.pathPrefixes.some((prefix) => pathMatchesPrefix(pathname, prefix)),
  ).map((feature) => feature.code);
};
