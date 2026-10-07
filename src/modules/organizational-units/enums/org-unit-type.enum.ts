export enum OrgUnitType {
  Rectorate = 'RECTORATE',
  Vicerectorate = 'VICERECTORATE',
  Faculty = 'FACULTY',
  Department = 'DEPARTMENT',
  Program = 'PROGRAM',
  Area = 'AREA',
  Direction = 'DIRECTION',
  Office = 'OFFICE',
  Center = 'CENTER',
  /** Consejo o comité (asesoría): no recibe centros de costo ni activos. */
  Council = 'COUNCIL',
  Other = 'OTHER',
}

export const ORG_UNIT_TYPES = [
  OrgUnitType.Rectorate,
  OrgUnitType.Vicerectorate,
  OrgUnitType.Faculty,
  OrgUnitType.Department,
  OrgUnitType.Program,
  OrgUnitType.Area,
  OrgUnitType.Direction,
  OrgUnitType.Office,
  OrgUnitType.Center,
  OrgUnitType.Council,
  OrgUnitType.Other,
] as const;

export const ORG_UNIT_TYPE_LABELS: Readonly<Record<OrgUnitType, string>> = {
  [OrgUnitType.Rectorate]: 'Rectoría',
  [OrgUnitType.Vicerectorate]: 'Vicerrectoría',
  [OrgUnitType.Faculty]: 'Facultad',
  [OrgUnitType.Department]: 'Departamento',
  [OrgUnitType.Program]: 'Programa',
  [OrgUnitType.Area]: 'Área',
  [OrgUnitType.Direction]: 'Dirección',
  [OrgUnitType.Office]: 'Oficina',
  [OrgUnitType.Center]: 'Centro',
  [OrgUnitType.Council]: 'Consejo o comité',
  [OrgUnitType.Other]: 'Otro',
};

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
