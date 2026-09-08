export interface NavigationDefinition {
  readonly module: string;
  readonly moduleLabel: string;
  readonly resource: string;
  readonly path: string;
  readonly label: string;
  readonly requiredAction: string;
  readonly sortOrder: number;
}

export const NAVIGATION_REGISTRY: ReadonlyArray<NavigationDefinition> = [
  {
    module: 'USER',
    moduleLabel: 'Administración',
    resource: 'user',
    path: '/users',
    label: 'Usuarios',
    requiredAction: 'read',
    sortOrder: 10,
  },
  {
    module: 'USER',
    moduleLabel: 'Administración',
    resource: 'role',
    path: '/roles',
    label: 'Roles y permisos',
    requiredAction: 'read',
    sortOrder: 20,
  },
  {
    module: 'STRUCTURE',
    moduleLabel: 'Estructura',
    resource: 'campus',
    path: '/campus',
    label: 'Campus y ubicaciones',
    requiredAction: 'read',
    sortOrder: 30,
  },
  {
    module: 'STRUCTURE',
    moduleLabel: 'Estructura',
    resource: 'org_unit',
    path: '/organizational-units',
    label: 'Unidades organizacionales',
    requiredAction: 'read',
    sortOrder: 40,
  },
  {
    module: 'STRUCTURE',
    moduleLabel: 'Estructura',
    resource: 'cost_center',
    path: '/cost-centers',
    label: 'Centros de costo',
    requiredAction: 'read',
    sortOrder: 50,
  },
  {
    module: 'ASSET',
    moduleLabel: 'Activos',
    resource: 'category',
    path: '/categories',
    label: 'Categorías',
    requiredAction: 'read',
    sortOrder: 60,
  },
  {
    module: 'ASSET',
    moduleLabel: 'Activos',
    resource: 'asset',
    path: '/assets',
    label: 'Activos',
    requiredAction: 'read',
    sortOrder: 70,
  },
  {
    module: 'INVENTORY',
    moduleLabel: 'Inventarios',
    resource: 'physical_inventory',
    path: '/inventories',
    label: 'Tomas físicas',
    requiredAction: 'read',
    sortOrder: 75,
  },
  {
    module: 'ASSET',
    moduleLabel: 'Activos',
    resource: 'loan',
    path: '/loans',
    label: 'Préstamos',
    requiredAction: 'read',
    sortOrder: 80,
  },
  {
    module: 'ASSET',
    moduleLabel: 'Activos',
    resource: 'depreciation',
    path: '/depreciation',
    label: 'Depreciación',
    requiredAction: 'read',
    sortOrder: 85,
  },
  {
    module: 'ASSET',
    moduleLabel: 'Activos',
    resource: 'document_template',
    path: '/document-templates',
    label: 'Plantillas',
    requiredAction: 'read',
    sortOrder: 90,
  },
  {
    module: 'SYSTEM',
    moduleLabel: 'Sistema',
    resource: 'storage',
    path: '/storage',
    label: 'Almacenamiento',
    requiredAction: 'update',
    sortOrder: 100,
  },
  {
    module: 'SYSTEM',
    moduleLabel: 'Sistema',
    resource: 'feature',
    path: '/features',
    label: 'Módulos',
    requiredAction: 'manage',
    sortOrder: 110,
  },
];
