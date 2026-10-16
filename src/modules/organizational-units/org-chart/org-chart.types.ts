import {
  ORG_RELATION_TYPE_LABELS,
  ORG_RELATION_TYPES,
  ORG_UNIT_TYPE_LABELS,
  ORG_UNIT_TYPES,
  type OrgRelationType,
  OrgUnitType,
} from '../enums/org-unit-type.enum.js';
import type { OrgChartStamp } from './org-chart-stamp.js';

export interface SnapshotUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unitType: OrgUnitType;
  readonly parentId: string | null;
  readonly relationType: OrgRelationType;
  readonly headCostCenterId: string | null;
  readonly headCostCenterCode: string | null;
  readonly codePrefix: string | null;
  readonly isActive: boolean;
  readonly color: string | null;
}

export interface SnapshotCenter {
  readonly id: string;
  readonly externalCode: string;
  readonly name: string;
  readonly hasMovement: boolean;
  readonly isActive: boolean;
  readonly unitId: string | null;
  readonly parentId: string | null;
  readonly activeAssets: number;
}

export interface RemovalReferences {
  readonly history: string | null;
}

export interface OrgChartSnapshot {
  readonly units: ReadonlyArray<SnapshotUnit>;
  readonly centers: ReadonlyArray<SnapshotCenter>;
  readonly removal: ReadonlyMap<string, RemovalReferences>;
}

export type RawValue = string | number | boolean | null;

export interface UnitRowInput {
  readonly rowNumber: number;
  readonly prefix: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly parent: string | null;
  readonly relation: string | null;
  readonly headCenter: string | null;
  readonly color?: string | null;
  readonly status: string | null;
  readonly action: string | null;
  readonly code: string | null;
}

export interface CenterRowInput {
  readonly rowNumber: number;
  readonly code: string | null;
  readonly name: string | null;
  readonly movement: string | null;
  readonly status: string | null;
  readonly action: string | null;
  readonly previousCode: string | null;
}

export interface OrgChartInput {
  readonly units: ReadonlyArray<UnitRowInput>;
  readonly centers: ReadonlyArray<CenterRowInput>;
  readonly hasUnitSheet: boolean;
  readonly hasCenterSheet: boolean;
  readonly ignoredCenterSheet?: boolean;
  readonly stamp?: OrgChartStamp | null;
  readonly invalidStamp?: boolean;
  readonly fileCreatedAt?: string | null;
}

export const unitsOnly = (input: OrgChartInput): OrgChartInput => ({
  units: input.units,
  centers: [],
  hasUnitSheet: input.hasUnitSheet,
  hasCenterSheet: false,
  ignoredCenterSheet: Boolean(input.ignoredCenterSheet) || input.hasCenterSheet,
  stamp: input.stamp ?? null,
  invalidStamp: Boolean(input.invalidStamp),
  fileCreatedAt: input.fileCreatedAt ?? null,
});

export const UNIT_SHEET = 'Organigrama';
export const CENTER_SHEET = 'Centros de costo';
export const INSTRUCTIONS_SHEET = 'Instrucciones';

export const UNIT_HEADERS = {
  prefix: 'Prefijo',
  name: 'Nombre',
  type: 'Tipo',
  parent: 'Depende de',
  relation: 'Línea',
  headCenter: 'Centro propio',
  color: 'Color',
  status: 'Estado',
  action: 'Acción',
  code: 'Código interno',
} as const;

export const CENTER_HEADERS = {
  code: 'Código',
  name: 'Nombre',
  movement: 'Movimiento',
  unit: 'Unidad',
  parent: 'Padre',
  assets: 'Activos',
  status: 'Estado',
  action: 'Acción',
  previousCode: 'Código anterior',
} as const;

export const STATUS_ACTIVE = 'Activo';
export const STATUS_ARCHIVED = 'Archivado';
export const ACTION_DELETE = 'ELIMINAR';
export const ACTION_ARCHIVE = 'ARCHIVAR';

export type RowAction = 'DELETE' | 'ARCHIVE' | null;

export const normalizeText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export const cellText = (value: RawValue | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
};

const UNIT_TYPE_BY_TEXT = new Map<string, OrgUnitType>(
  ORG_UNIT_TYPES.flatMap((type) => [
    [normalizeText(ORG_UNIT_TYPE_LABELS[type]), type],
    [normalizeText(type), type],
  ]),
);
const LEGACY_UNIT_TYPE_LABELS: ReadonlyArray<readonly [string, OrgUnitType]> = [
  ['Consejo o comité', OrgUnitType.Council],
  ['Área', OrgUnitType.Dependency],
  ['AREA', OrgUnitType.Dependency],
  ['Otro', OrgUnitType.Dependency],
  ['OTHER', OrgUnitType.Dependency],
  ['Programa', OrgUnitType.Program],
];
for (const [label, type] of LEGACY_UNIT_TYPE_LABELS) {
  UNIT_TYPE_BY_TEXT.set(normalizeText(label), type);
}

export const UNIT_TYPE_OPTIONS = ORG_UNIT_TYPES.map((type) => ORG_UNIT_TYPE_LABELS[type]).join(', ');

export const parseUnitType = (text: string): OrgUnitType | undefined => UNIT_TYPE_BY_TEXT.get(normalizeText(text));

const RELATION_BY_TEXT = new Map<string, OrgRelationType>(
  ORG_RELATION_TYPES.flatMap((type) => [
    [normalizeText(ORG_RELATION_TYPE_LABELS[type]), type],
    [normalizeText(type), type],
  ]),
);

export const parseRelation = (text: string): OrgRelationType | undefined => RELATION_BY_TEXT.get(normalizeText(text));

export const parseStatus = (text: string): boolean | undefined => {
  const normalized = normalizeText(text);
  if (['activo', 'activa', 'active'].includes(normalized)) {
    return true;
  }
  if (['archivado', 'archivada', 'inactivo', 'inactiva', 'archived'].includes(normalized)) {
    return false;
  }
  return undefined;
};

export const parseAction = (text: string): RowAction | undefined => {
  const normalized = normalizeText(text);
  if (normalized === 'eliminar' || normalized === 'borrar') {
    return 'DELETE';
  }
  if (normalized === 'archivar') {
    return 'ARCHIVE';
  }
  return undefined;
};

export const parseMovement = (text: string): boolean | undefined => {
  const normalized = normalizeText(text);
  if (['1', 'si', 'true', 'verdadero'].includes(normalized)) {
    return true;
  }
  if (['0', 'no', 'false', 'falso'].includes(normalized)) {
    return false;
  }
  return undefined;
};
