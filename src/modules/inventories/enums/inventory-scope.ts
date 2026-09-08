export enum InventoryScopeType {
  Global = 'GLOBAL',
  CostCenter = 'COST_CENTER',
  Location = 'LOCATION',
  OrgUnit = 'ORG_UNIT',
}

export const INVENTORY_SCOPE_TYPES = [
  InventoryScopeType.Global,
  InventoryScopeType.CostCenter,
  InventoryScopeType.Location,
  InventoryScopeType.OrgUnit,
] as const;
