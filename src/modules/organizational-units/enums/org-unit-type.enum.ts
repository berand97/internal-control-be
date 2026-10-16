export enum OrgUnitType {
  Dependency = 'DEPENDENCY',
  Rectorate = 'RECTORATE',
  Vicerectorate = 'VICERECTORATE',
  Direction = 'DIRECTION',
  Faculty = 'FACULTY',
  Department = 'DEPARTMENT',
  Program = 'PROGRAM',
  Office = 'OFFICE',
  Center = 'CENTER',
  Council = 'COUNCIL',
  Committee = 'COMMITTEE',
  Commission = 'COMMISSION',
}

export const ORG_UNIT_TYPES = [
  OrgUnitType.Dependency,
  OrgUnitType.Rectorate,
  OrgUnitType.Vicerectorate,
  OrgUnitType.Direction,
  OrgUnitType.Faculty,
  OrgUnitType.Department,
  OrgUnitType.Program,
  OrgUnitType.Office,
  OrgUnitType.Center,
  OrgUnitType.Council,
  OrgUnitType.Committee,
  OrgUnitType.Commission,
] as const;

export const ORG_UNIT_TYPE_LABELS: Readonly<Record<OrgUnitType, string>> = {
  [OrgUnitType.Dependency]: 'Dependencia',
  [OrgUnitType.Rectorate]: 'Rectoría',
  [OrgUnitType.Vicerectorate]: 'Vicerrectoría',
  [OrgUnitType.Direction]: 'Dirección',
  [OrgUnitType.Faculty]: 'Facultad',
  [OrgUnitType.Department]: 'Departamento',
  [OrgUnitType.Program]: 'Coordinación de programa',
  [OrgUnitType.Office]: 'Oficina',
  [OrgUnitType.Center]: 'Centro',
  [OrgUnitType.Council]: 'Consejo',
  [OrgUnitType.Committee]: 'Comité',
  [OrgUnitType.Commission]: 'Comisión',
};

export const COLLEGIATE_BODY_TYPES: ReadonlyArray<OrgUnitType> = [
  OrgUnitType.Council,
  OrgUnitType.Committee,
  OrgUnitType.Commission,
];

export const isCollegiateBody = (type: OrgUnitType | string | null | undefined): boolean =>
  COLLEGIATE_BODY_TYPES.includes(type as OrgUnitType);

export const ORG_UNIT_TYPE_DESCRIPTION = `Tipo de unidad (Estructura Orgánica, Acuerdo 008/2021): ${ORG_UNIT_TYPES.map(
  (type) => `${type} = ${ORG_UNIT_TYPE_LABELS[type]}`,
).join('; ')}. COUNCIL, COMMITTEE y COMMISSION son cuerpos colegiados: sin prefijo ni centros de costo.`;

export enum OrgRelationType {
  Authority = 'AUTHORITY',
  Advisory = 'ADVISORY',
  Coordination = 'COORDINATION',
}

export const ORG_RELATION_TYPES = [
  OrgRelationType.Authority,
  OrgRelationType.Advisory,
  OrgRelationType.Coordination,
] as const;

export const ORG_RELATION_TYPE_LABELS: Readonly<Record<OrgRelationType, string>> = {
  [OrgRelationType.Authority]: 'Autoridad',
  [OrgRelationType.Advisory]: 'Asesoría',
  [OrgRelationType.Coordination]: 'Coordinación',
};
