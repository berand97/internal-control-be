export enum ImportMode {
  AllOrNothing = 'all-or-nothing',
  Partial = 'partial',
}

export const IMPORT_MODES = [ImportMode.AllOrNothing, ImportMode.Partial] as const;
