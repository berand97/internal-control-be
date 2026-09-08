export enum OrgUnitType {
  Rectorate = 'RECTORATE',
  Vicerectorate = 'VICERECTORATE',
  Faculty = 'FACULTY',
  Department = 'DEPARTMENT',
  Program = 'PROGRAM',
  Area = 'AREA',
}

export const ORG_UNIT_TYPES = [
  OrgUnitType.Rectorate,
  OrgUnitType.Vicerectorate,
  OrgUnitType.Faculty,
  OrgUnitType.Department,
  OrgUnitType.Program,
  OrgUnitType.Area,
] as const;
