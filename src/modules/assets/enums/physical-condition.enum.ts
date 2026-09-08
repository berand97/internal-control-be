export enum PhysicalCondition {
  New = 'NEW',
  Good = 'GOOD',
  Fair = 'FAIR',
  Poor = 'POOR',
  Obsolete = 'OBSOLETE',
}

export const PHYSICAL_CONDITIONS = [
  PhysicalCondition.New,
  PhysicalCondition.Good,
  PhysicalCondition.Fair,
  PhysicalCondition.Poor,
  PhysicalCondition.Obsolete,
] as const;
