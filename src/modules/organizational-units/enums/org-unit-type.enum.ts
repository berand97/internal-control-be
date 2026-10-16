/**
 * Tipos de unidad de la Estructura Orgánica de la UNAC (Acuerdo 008 de 2021, modificado en 2025, numeral 1.5).
 *
 * Consejo, Comité y Comisión son cuerpos colegiados: no llevan prefijo, centros de costo ni centro propio
 * (ver isCollegiateBody).
 */
export enum OrgUnitType {
  /** Instancia académica o administrativa genérica (reemplaza los antiguos AREA y OTHER). */
  Dependency = 'DEPENDENCY',
  Rectorate = 'RECTORATE',
  Vicerectorate = 'VICERECTORATE',
  Direction = 'DIRECTION',
  Faculty = 'FACULTY',
  Department = 'DEPARTMENT',
  /** Coordinación de programa académico. */
  Program = 'PROGRAM',
  Office = 'OFFICE',
  Center = 'CENTER',
  /** Cuerpo colegiado: no recibe centros de costo ni activos. */
  Council = 'COUNCIL',
  /** Cuerpo colegiado: no recibe centros de costo ni activos. */
  Committee = 'COMMITTEE',
  /** Cuerpo colegiado: no recibe centros de costo ni activos. */
  Commission = 'COMMISSION',
}

/** En el orden de la Estructura Orgánica (es el orden de las listas). */
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

/** Consejo, Comité y Comisión. */
export const COLLEGIATE_BODY_TYPES: ReadonlyArray<OrgUnitType> = [
  OrgUnitType.Council,
  OrgUnitType.Committee,
  OrgUnitType.Commission,
];

/** Cuerpo colegiado (Consejo, Comité, Comisión): sin prefijo, sin centros de costo y sin centro propio. */
export const isCollegiateBody = (type: OrgUnitType | string | null | undefined): boolean =>
  COLLEGIATE_BODY_TYPES.includes(type as OrgUnitType);

/** Descripción de Swagger: cada código con su etiqueta. */
export const ORG_UNIT_TYPE_DESCRIPTION = `Tipo de unidad (Estructura Orgánica, Acuerdo 008/2021): ${ORG_UNIT_TYPES.map(
  (type) => `${type} = ${ORG_UNIT_TYPE_LABELS[type]}`,
).join('; ')}. COUNCIL, COMMITTEE y COMMISSION son cuerpos colegiados: sin prefijo ni centros de costo.`;

/** Línea del organigrama hacia el padre. */
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
