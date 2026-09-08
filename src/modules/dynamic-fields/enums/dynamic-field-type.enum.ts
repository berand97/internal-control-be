export enum DynamicFieldType {
  String = 'STRING',
  Number = 'NUMBER',
  Boolean = 'BOOLEAN',
  Date = 'DATE',
  Select = 'SELECT',
}

export const DYNAMIC_FIELD_TYPES = [
  DynamicFieldType.String,
  DynamicFieldType.Number,
  DynamicFieldType.Boolean,
  DynamicFieldType.Date,
  DynamicFieldType.Select,
] as const;
