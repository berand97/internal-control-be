export const OpenApiTag = {
  Auth: 'Autenticación',
  Roles: 'Roles',
  Permissions: 'Permisos',
  Users: 'Usuarios',
  OrganizationalUnits: 'Unidades organizacionales',
  CostCenters: 'Centros de costo',
  Campus: 'Sedes',
  Buildings: 'Edificios',
  Locations: 'Ubicaciones',
  Categories: 'Categorías',
  DynamicFields: 'Campos dinámicos',
  Assets: 'Activos',
  QrTokens: 'Códigos QR',
  Movements: 'Movimientos',
  Loans: 'Préstamos',
  Inventories: 'Tomas físicas',
  Depreciation: 'Depreciación',
  DocumentTemplates: 'Plantillas Word',
  Storage: 'Almacenamiento',
  Mail: 'Correo',
  Features: 'Módulos',
  Navigation: 'Menús',
  Health: 'Salud',
} as const;

export const OPENAPI_TAG_META: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
}> = [
  { name: OpenApiTag.Auth, description: 'Login, sesión, MFA y perfil' },
  { name: OpenApiTag.Roles, description: 'Roles y reglas de segregación de funciones' },
  { name: OpenApiTag.Permissions, description: 'Catálogo de permisos' },
  { name: OpenApiTag.Users, description: 'Usuarios y asignación de roles' },
  {
    name: OpenApiTag.OrganizationalUnits,
    description: 'Árbol de unidades organizacionales',
  },
  { name: OpenApiTag.CostCenters, description: 'Centros de costo' },
  { name: OpenApiTag.Campus, description: 'Sedes físicas' },
  { name: OpenApiTag.Buildings, description: 'Edificios de una sede' },
  { name: OpenApiTag.Locations, description: 'Ubicaciones físicas' },
  { name: OpenApiTag.Categories, description: 'Árbol de categorías de activos' },
  {
    name: OpenApiTag.DynamicFields,
    description: 'Campos dinámicos por categoría',
  },
  { name: OpenApiTag.Assets, description: 'Inventario de activos' },
  { name: OpenApiTag.QrTokens, description: 'Emisión, rotación y verificación de QR' },
  { name: OpenApiTag.Movements, description: 'Histórico append-only de movimientos' },
  { name: OpenApiTag.Loans, description: 'Préstamos entre dependencias' },
  {
    name: OpenApiTag.Inventories,
    description: 'Tomas físicas, verificación y reconciliación',
  },
  {
    name: OpenApiTag.Depreciation,
    description: 'Snapshots mensuales de depreciación en línea recta',
  },
  { name: OpenApiTag.DocumentTemplates, description: 'Plantillas Word y generación de actas' },
  { name: OpenApiTag.Storage, description: 'Proveedores de archivos: proyecto, S3, Drive, OneDrive' },
  { name: OpenApiTag.Mail, description: 'SMTP y envío de invitaciones' },
  {
    name: OpenApiTag.Features,
    description:
      'Feature flags y apagado de módulos. El frontend oculta lo que venga con enabled=false.',
  },
  {
    name: OpenApiTag.Navigation,
    description:
      'Catálogo administrable de menús. La visibilidad por usuario se deriva de permisos.',
  },
  { name: OpenApiTag.Health, description: 'Disponibilidad del API' },
];

export const OPENAPI_TAG_GROUPS: ReadonlyArray<{
  readonly name: string;
  readonly tags: readonly string[];
}> = [
  {
    name: 'Acceso',
    tags: [
      OpenApiTag.Auth,
      OpenApiTag.Roles,
      OpenApiTag.Permissions,
      OpenApiTag.Users,
    ],
  },
  {
    name: 'Estructura institucional',
    tags: [
      OpenApiTag.OrganizationalUnits,
      OpenApiTag.CostCenters,
      OpenApiTag.Campus,
      OpenApiTag.Buildings,
      OpenApiTag.Locations,
    ],
  },
  {
    name: 'Catálogo',
    tags: [OpenApiTag.Categories, OpenApiTag.DynamicFields],
  },
  {
    name: 'Inventario',
    tags: [
      OpenApiTag.Assets,
      OpenApiTag.QrTokens,
      OpenApiTag.Movements,
      OpenApiTag.Loans,
      OpenApiTag.Inventories,
      OpenApiTag.Depreciation,
    ],
  },
  {
    name: 'Documentos y almacenamiento',
    tags: [OpenApiTag.DocumentTemplates, OpenApiTag.Storage, OpenApiTag.Mail],
  },
  {
    name: 'Sistema',
    tags: [OpenApiTag.Features, OpenApiTag.Navigation, OpenApiTag.Health],
  },
];
