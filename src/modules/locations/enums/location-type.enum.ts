export enum LocationType {
  Office = 'OFFICE',
  Classroom = 'CLASSROOM',
  Lab = 'LAB',
  Warehouse = 'WAREHOUSE',
  CommonArea = 'COMMON_AREA',
  Other = 'OTHER',
}

export const LOCATION_TYPES = [
  LocationType.Office,
  LocationType.Classroom,
  LocationType.Lab,
  LocationType.Warehouse,
  LocationType.CommonArea,
  LocationType.Other,
] as const;
