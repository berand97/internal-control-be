import {
  ORG_RELATION_TYPE_LABELS,
  ORG_RELATION_TYPES,
  ORG_UNIT_TYPE_LABELS,
  ORG_UNIT_TYPES,
  type OrgRelationType,
  type OrgUnitType,
} from '../enums/org-unit-type.enum.js';

/** Estado actual de la estructura (lo que el Excel compara). */
export interface SnapshotUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unitType: OrgUnitType;
  readonly parentId: string | null;
  readonly relationType: OrgRelationType;
  readonly headCostCenterId: string | null;
  readonly codePrefix: string | null;
  readonly isActive: boolean;
}

export interface SnapshotCenter {
  readonly id: string;
  readonly externalCode: string;
  readonly name: string;
  readonly hasMovement: boolean;
  readonly isActive: boolean;
  readonly unitId: string | null;
  readonly parentId: string | null;
  /** Activos no dados de baja que hoy están en el centro. */
  readonly activeAssets: number;
}

/** Resultado de revisar una fila marcada ELIMINAR (referencias históricas leídas de la base). */
export interface RemovalReferences {
  /** Descripción de la historia que obliga a archivar; null si no hay ninguna. */
  readonly history: string | null;
}

export interface OrgChartSnapshot {
  readonly units: ReadonlyArray<SnapshotUnit>;
  readonly centers: ReadonlyArray<SnapshotCenter>;
  /** Por id de unidad o centro marcado ELIMINAR. */
  readonly removal: ReadonlyMap<string, RemovalReferences>;
}

export type RawValue = string | number | boolean | null;

/** Fila de la hoja «Organigrama» tal como se leyó (texto sin interpretar). */
export interface UnitRowInput {
  readonly rowNumber: number;
  readonly prefix: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly parent: string | null;
  readonly relation: string | null;
  readonly headCenter: string | null;
  readonly status: string | null;
  readonly action: string | null;
  readonly code: string | null;
}

/** Fila de la hoja «Centros de costo» tal como se leyó. */
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
  /**
   * Filas de centros para el plan. El Excel del organigrama nunca las trae (vacío y hasCenterSheet false): los centros
   * se administran en su propia pantalla. El plan conserva su lógica para reusarla allí.
   */
  readonly centers: ReadonlyArray<CenterRowInput>;
  /** Hojas que trae el archivo: una hoja ausente no toca nada de lo suyo. */
  readonly hasUnitSheet: boolean;
  readonly hasCenterSheet: boolean;
  /** El archivo traía la hoja «Centros de costo» (archivos viejos) y se ignoró: el plan lo advierte. */
  readonly ignoredCenterSheet?: boolean;
}

/**
 * Lo que el Excel del organigrama planea: solo unidades. Descarta las filas de centros (también las de previsualizaciones
 * guardadas antes de quitar la hoja) y marca la hoja como ignorada.
 */
export const unitsOnly = (input: OrgChartInput): OrgChartInput => ({
  units: input.units,
  centers: [],
  hasUnitSheet: input.hasUnitSheet,
  hasCenterSheet: false,
  ignoredCenterSheet: Boolean(input.ignoredCenterSheet) || input.hasCenterSheet,
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

/** Sin tildes, minúsculas y sin espacios repetidos: para comparar encabezados y valores de listas. */
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
UNIT_TYPE_BY_TEXT.set('consejo', 'COUNCIL' as OrgUnitType);
UNIT_TYPE_BY_TEXT.set('comite', 'COUNCIL' as OrgUnitType);

export const parseUnitType = (text: string): OrgUnitType | undefined => UNIT_TYPE_BY_TEXT.get(normalizeText(text));

const RELATION_BY_TEXT = new Map<string, OrgRelationType>(
  ORG_RELATION_TYPES.flatMap((type) => [
    [normalizeText(ORG_RELATION_TYPE_LABELS[type]), type],
    [normalizeText(type), type],
  ]),
);

export const parseRelation = (text: string): OrgRelationType | undefined => RELATION_BY_TEXT.get(normalizeText(text));

/** Estado: true activo, false archivado, undefined si no se entiende. */
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

/** Movimiento: 1/0, Sí/No. */
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
