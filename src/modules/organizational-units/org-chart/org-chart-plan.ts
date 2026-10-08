import { createHash } from 'node:crypto';
import { isDetailCode } from '../../cost-centers/domain/code-prefix.js';
import {
  checkUnitPrefix,
  normalizeUnitPrefix,
  resolveCenterParent,
  resolveCenterUnit,
} from '../../cost-centers/domain/org-chart-rules.js';
import {
  ORG_RELATION_TYPE_LABELS,
  ORG_UNIT_TYPE_LABELS,
  OrgRelationType,
  OrgUnitType,
} from '../enums/org-unit-type.enum.js';
import {
  CENTER_HEADERS,
  CENTER_SHEET,
  type CenterRowInput,
  normalizeText,
  type OrgChartInput,
  type OrgChartSnapshot,
  parseAction,
  parseMovement,
  parseRelation,
  parseStatus,
  parseUnitType,
  type RowAction,
  UNIT_HEADERS,
  UNIT_SHEET,
  type UnitRowInput,
} from './org-chart.types.js';

/**
 * Plan de la importación del organigrama: compara las filas del Excel con el estado actual y dice qué cambiaría, sin
 * tocar nada. Puro (sin base): el servicio lo calcula en la previsualización y otra vez al confirmar, dentro de la
 * transacción, y solo aplica si el plan es el mismo (hash).
 *
 * - Las filas que no están en el archivo no se tocan; solo la columna Acción borra o archiva.
 * - Unidad: se identifica por «Código interno»; sin él, por el prefijo de una unidad activa; si no, es nueva (el código
 *   interno se genera del prefijo o del nombre).
 * - Centro: por «Código anterior» (recodificación: el mismo centro, con sus activos e historia, pasa al código nuevo) o
 *   por «Código»; si no, es nuevo.
 * - Prefijo con el código de Contabilidad: 4 dígitos con ceros al final se toman sin ellos (1200 → 12); «Depende de»
 *   acepta además el código del centro propio del jefe (4010 → la Vicerrectoría Financiera).
 * - Columnas vacías de una unidad: la existente conserva su valor (Prefijo, Depende de, Línea, Centro propio, Estado);
 *   para quitarlo a propósito se escribe «RAÍZ» o «NINGUNO». La nueva deduce lo que puede: el padre por el prefijo
 *   (43 → 4) o la Rectoría (prefijo de un dígito, si hay una sola; una Rectoría nunca se ubica sola), Línea Autoridad
 *   y el centro propio: el Prefijo de 4 dígitos si es un centro (1510) o, con prefijo X, X010 si existe.
 * - Centros: el Excel del organigrama no los trae (unitsOnly): Centro propio y Depende de se validan y deducen contra
 *   los centros que existen en el sistema, y una hoja «Centros de costo» de un archivo viejo solo deja una advertencia.
 *   La parte de centros de este plan (filas de centros con su unidad y padre derivados del código, org-chart-rules.ts)
 *   queda sin uso aquí, para el Excel de la pantalla de centros de costo.
 */

export const IGNORED_CENTER_SHEET_WARNING = 'La hoja Centros de costo se ignoró: los centros se administran en su propia pantalla';

export type UnitChangeKind =
  | 'CREATED'
  | 'RENAMED'
  | 'MOVED'
  | 'RETYPED'
  | 'PREFIX_CHANGED'
  | 'RELATION_CHANGED'
  | 'HEAD_CHANGED'
  | 'REACTIVATED'
  | 'ARCHIVED'
  | 'DELETED';

export type CenterChangeKind =
  | 'CREATED'
  | 'RENAMED'
  | 'RECODED'
  | 'RELOCATED'
  | 'MOVEMENT_CHANGED'
  | 'REACTIVATED'
  | 'ARCHIVED'
  | 'DELETED';

export const UNIT_CHANGE_KINDS: ReadonlyArray<UnitChangeKind> = [
  'CREATED',
  'RENAMED',
  'MOVED',
  'RETYPED',
  'PREFIX_CHANGED',
  'RELATION_CHANGED',
  'HEAD_CHANGED',
  'REACTIVATED',
  'ARCHIVED',
  'DELETED',
];

export const CENTER_CHANGE_KINDS: ReadonlyArray<CenterChangeKind> = [
  'CREATED',
  'RENAMED',
  'RECODED',
  'RELOCATED',
  'MOVEMENT_CHANGED',
  'REACTIVATED',
  'ARCHIVED',
  'DELETED',
];

export interface RowIssue {
  readonly sheet: string;
  readonly rowNumber: number;
  readonly column: string | null;
  readonly message: string;
}

export interface UnitOp {
  /** id de la unidad existente o «new:<código>». */
  readonly key: string;
  readonly existingId: string | null;
  readonly rowNumber: number;
  readonly code: string;
  readonly name: string;
  readonly unitType: OrgUnitType;
  readonly relationType: OrgRelationType;
  readonly codePrefix: string | null;
  readonly parentKey: string | null;
  readonly headCenterKey: string | null;
  readonly isActive: boolean;
  readonly removal: 'DELETE' | 'ARCHIVE' | null;
  readonly kinds: ReadonlyArray<UnitChangeKind>;
}

export interface CenterOp {
  /** id del centro existente o «new:<código>». */
  readonly key: string;
  readonly existingId: string | null;
  readonly rowNumber: number;
  readonly code: string;
  readonly previousCode: string | null;
  readonly name: string;
  readonly hasMovement: boolean;
  readonly isActive: boolean;
  readonly unitKey: string | null;
  readonly parentKey: string | null;
  readonly removal: 'DELETE' | 'ARCHIVE' | null;
  readonly kinds: ReadonlyArray<CenterChangeKind>;
}

export interface PlanChange {
  readonly sheet: string;
  readonly rowNumber: number;
  readonly entity: 'ORG_UNIT' | 'COST_CENTER';
  readonly kind: UnitChangeKind | CenterChangeKind;
  /** Prefijo o código interno de la unidad; código del centro. */
  readonly code: string;
  readonly name: string;
  readonly detail: string;
}

export interface OrgChartPlan {
  readonly units: ReadonlyArray<UnitOp>;
  readonly centers: ReadonlyArray<CenterOp>;
  readonly changes: ReadonlyArray<PlanChange>;
  readonly errors: ReadonlyArray<RowIssue>;
  readonly warnings: ReadonlyArray<RowIssue>;
  readonly unitCounts: Readonly<Record<UnitChangeKind, number>>;
  readonly centerCounts: Readonly<Record<CenterChangeKind, number>>;
  readonly hash: string;
}

const NEW = 'new:';
const PREFIX_PATTERN = /^[0-9]{1,4}$/;
const UNIT_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const UNIT_CODE_MAX = 20;
const CENTER_CODE_PATTERN = /^[0-9]{1,10}$/;
const NAME_MAX = 200;
const MAX_DEPTH = 64;

interface FinalUnit {
  key: string;
  existingId: string | null;
  rowNumber: number | null;
  code: string;
  name: string;
  unitType: OrgUnitType;
  relationType: OrgRelationType;
  codePrefix: string | null;
  /** Prefijo tal como vino en el archivo (1200), antes de normalizarlo (12). */
  rawPrefix: string | null;
  parentKey: string | null;
  headCenterKey: string | null;
  isActive: boolean;
  removal: 'DELETE' | 'ARCHIVE' | null;
  parentText: string | null;
  headCenterText: string | null;
}

interface FinalCenter {
  key: string;
  existingId: string | null;
  rowNumber: number | null;
  code: string;
  previousCode: string | null;
  name: string;
  hasMovement: boolean;
  isActive: boolean;
  unitKey: string | null;
  parentKey: string | null;
  removal: 'DELETE' | 'ARCHIVE' | null;
  activeAssets: number;
}

const isBlankUnitRow = (row: UnitRowInput): boolean =>
  [row.prefix, row.name, row.type, row.parent, row.relation, row.headCenter, row.status, row.action, row.code].every(
    (value) => value === null,
  );

/** «RAÍZ» en Depende de: la unidad queda en la raíz a propósito. */
const isRootText = (text: string): boolean => normalizeText(text) === 'raiz';

/** «NINGUNO» en Centro propio: se le quita a propósito. */
const isNoneText = (text: string): boolean => ['ninguno', 'ninguna'].includes(normalizeText(text));

const isBlankCenterRow = (row: CenterRowInput): boolean =>
  [row.code, row.name, row.movement, row.status, row.action, row.previousCode].every((value) => value === null);

const asciiSlug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Código interno de una unidad nueva: U<prefijo> o el nombre en mayúsculas sin tildes; único. */
export const generateUnitCode = (prefix: string | null, name: string, used: ReadonlySet<string>): string => {
  const slug = asciiSlug(name);
  const base = prefix ? `U${prefix}` : /^[A-Z]/.test(slug) ? slug : `U_${slug}`;
  const trimmed = base.slice(0, UNIT_CODE_MAX).replace(/_+$/g, '') || 'UNIDAD';
  if (!used.has(trimmed)) {
    return trimmed;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tail = `_${suffix}`;
    const candidate = `${trimmed.slice(0, UNIT_CODE_MAX - tail.length)}${tail}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
};

const emptyCounts = <K extends string>(kinds: ReadonlyArray<K>): Record<K, number> =>
  Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<K, number>;

export const planOrgChart = (snapshot: OrgChartSnapshot, input: OrgChartInput): OrgChartPlan => {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const unitError = (row: number, column: string | null, message: string) =>
    errors.push({ sheet: UNIT_SHEET, rowNumber: row, column, message });
  const unitWarning = (row: number, column: string | null, message: string) =>
    warnings.push({ sheet: UNIT_SHEET, rowNumber: row, column, message });
  const centerError = (row: number, column: string | null, message: string) =>
    errors.push({ sheet: CENTER_SHEET, rowNumber: row, column, message });
  const centerWarning = (row: number, column: string | null, message: string) =>
    warnings.push({ sheet: CENTER_SHEET, rowNumber: row, column, message });

  if (input.ignoredCenterSheet) {
    warnings.push({ sheet: CENTER_SHEET, rowNumber: 1, column: null, message: IGNORED_CENTER_SHEET_WARNING });
  }

  // ─── Estado actual ────────────────────────────────────────────────────────────────────────────────────────────
  const snapshotUnits = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  const snapshotCenters = new Map(snapshot.centers.map((center) => [center.id, center]));
  const units = new Map<string, FinalUnit>(
    snapshot.units.map((unit) => [
      unit.id,
      {
        key: unit.id,
        existingId: unit.id,
        rowNumber: null,
        code: unit.code,
        name: unit.name,
        unitType: unit.unitType,
        relationType: unit.relationType,
        codePrefix: unit.codePrefix,
        rawPrefix: unit.codePrefix,
        parentKey: unit.parentId,
        headCenterKey: unit.headCostCenterId,
        isActive: unit.isActive,
        removal: null,
        parentText: null,
        headCenterText: null,
      },
    ]),
  );
  const centers = new Map<string, FinalCenter>(
    snapshot.centers.map((center) => [
      center.id,
      {
        key: center.id,
        existingId: center.id,
        rowNumber: null,
        code: center.externalCode,
        previousCode: null,
        name: center.name,
        hasMovement: center.hasMovement,
        isActive: center.isActive,
        unitKey: center.unitId,
        parentKey: center.parentId,
        removal: null,
        activeAssets: center.activeAssets,
      },
    ]),
  );
  const unitByCode = new Map(snapshot.units.map((unit) => [unit.code, unit]));
  const activeUnitByPrefix = new Map(
    snapshot.units.filter((unit) => unit.isActive && unit.codePrefix).map((unit) => [unit.codePrefix ?? '', unit]),
  );
  const centerByCode = new Map(snapshot.centers.map((center) => [center.externalCode, center]));
  const usedUnitCodes = new Set(snapshot.units.map((unit) => unit.code));

  // ─── Hoja Organigrama: identidad y valores de cada fila ─────────────────────────────────────────────────────
  const unitRows = new Map<string, number>();
  if (input.hasUnitSheet) {
    for (const row of input.units) {
      if (isBlankUnitRow(row)) {
        continue;
      }
      const at = row.rowNumber;
      let valid = true;
      if (!row.name) {
        unitError(at, UNIT_HEADERS.name, 'El nombre es obligatorio');
        valid = false;
      } else if (row.name.length > NAME_MAX) {
        unitError(at, UNIT_HEADERS.name, `El nombre admite hasta ${NAME_MAX} caracteres`);
        valid = false;
      }
      const prefixRemoved = row.prefix !== null && isNoneText(row.prefix);
      if (row.prefix && !prefixRemoved && !PREFIX_PATTERN.test(row.prefix)) {
        unitError(at, UNIT_HEADERS.prefix, `«${row.prefix}» no es un prefijo: son de 1 a 4 dígitos`);
        valid = false;
      }
      const type = row.type ? parseUnitType(row.type) : undefined;
      if (row.type && !type) {
        unitError(at, UNIT_HEADERS.type, `Tipo desconocido «${row.type}»: elija uno de la lista`);
        valid = false;
      }
      // Vacío: la existente conserva su línea; la nueva queda en Autoridad.
      const relation = row.relation ? parseRelation(row.relation) : undefined;
      if (row.relation && !relation) {
        unitError(at, UNIT_HEADERS.relation, `Línea desconocida «${row.relation ?? ''}»: Autoridad, Asesoría o Coordinación`);
        valid = false;
      }
      const status = row.status ? parseStatus(row.status) : undefined;
      if (row.status && status === undefined) {
        unitError(at, UNIT_HEADERS.status, `Estado desconocido «${row.status}»: Activo o Archivado`);
        valid = false;
      }
      const action: RowAction | undefined = row.action ? parseAction(row.action) : null;
      if (action === undefined) {
        unitError(at, UNIT_HEADERS.action, `Acción desconocida «${row.action ?? ''}»: deje vacío, ELIMINAR o ARCHIVAR`);
        valid = false;
      }

      // El código interno distingue mayúsculas en la base (S24c5809 y S24C5809 pueden ser dos unidades): primero el
      // exacto; en mayúsculas solo si no hay exacto.
      let existing = row.code ? (unitByCode.get(row.code) ?? unitByCode.get(row.code.toUpperCase())) : undefined;
      let code = row.code ? (existing?.code ?? row.code.toUpperCase()) : null;
      if (!existing && code) {
        if (!UNIT_CODE_PATTERN.test(code) || code.length > UNIT_CODE_MAX) {
          unitError(
            at,
            UNIT_HEADERS.code,
            `«${row.code ?? ''}» no es un código interno válido (mayúsculas, dígitos y _, hasta ${UNIT_CODE_MAX})`,
          );
          valid = false;
        }
      }
      // Sin código interno: por el prefijo exacto y, si no, por el normalizado (1000 encuentra la Rectoría «1»).
      if (!existing && !code && row.prefix && !prefixRemoved) {
        existing = activeUnitByPrefix.get(row.prefix) ?? activeUnitByPrefix.get(normalizeUnitPrefix(row.prefix));
      }
      if (!valid) {
        continue;
      }
      if (!existing && action) {
        unitWarning(at, UNIT_HEADERS.action, 'Fila nueva marcada para eliminar o archivar: se ignora');
        continue;
      }
      if (!existing && !type) {
        unitError(at, UNIT_HEADERS.type, 'El tipo es obligatorio para una unidad nueva');
        continue;
      }
      // Código de Contabilidad de 4 dígitos con ceros al final → prefijo corto (1200 → 12), salvo que la unidad ya
      // tenga guardado ese mismo valor.
      // Vacío: la existente conserva el suyo; NINGUNO lo quita.
      const filePrefix = prefixRemoved ? null : row.prefix;
      const prefix = !filePrefix
        ? prefixRemoved
          ? null
          : (existing?.codePrefix ?? null)
        : existing?.codePrefix !== filePrefix
          ? normalizeUnitPrefix(filePrefix)
          : filePrefix;
      if (!existing) {
        code = code ?? generateUnitCode(prefix, row.name ?? '', usedUnitCodes);
        usedUnitCodes.add(code);
      }
      const key = existing ? existing.id : `${NEW}${code ?? ''}`;
      const previousRow = unitRows.get(key);
      if (previousRow !== undefined) {
        unitError(at, existing ? UNIT_HEADERS.code : UNIT_HEADERS.prefix, `La unidad ya está en la fila ${previousRow}`);
        continue;
      }
      unitRows.set(key, at);
      if (filePrefix && prefix !== filePrefix) {
        unitWarning(at, UNIT_HEADERS.prefix, `${filePrefix} se tomó como prefijo ${prefix ?? ''}`);
      }
      const current = units.get(key);
      units.set(key, {
        key,
        existingId: existing?.id ?? null,
        rowNumber: at,
        code: existing?.code ?? code ?? '',
        name: row.name ?? '',
        unitType: type ?? current?.unitType ?? OrgUnitType.Other,
        relationType: relation ?? current?.relationType ?? OrgRelationType.Authority,
        codePrefix: prefix,
        rawPrefix: filePrefix ?? prefix,
        // Vacíos en el archivo: la existente conserva padre y centro propio (se resuelven más abajo).
        parentKey: current?.parentKey ?? null,
        headCenterKey: current?.headCenterKey ?? null,
        isActive: action === 'ARCHIVE' ? false : (status ?? current?.isActive ?? true),
        removal: action ?? null,
        parentText: row.parent,
        headCenterText: row.headCenter,
      });
    }
  }

  const isLiveUnit = (unit: FinalUnit | undefined): boolean => Boolean(unit && unit.isActive && unit.removal === null);

  // ─── Hoja Centros de costo ─────────────────────────────────────────────────────────────────────────────────────
  const centerRows = new Map<string, number>();
  const codeRows = new Map<string, number>();
  if (input.hasCenterSheet) {
    for (const row of input.centers) {
      if (isBlankCenterRow(row)) {
        continue;
      }
      const at = row.rowNumber;
      let valid = true;
      if (!row.code) {
        centerError(at, CENTER_HEADERS.code, 'El código es obligatorio');
        continue;
      }
      if (!CENTER_CODE_PATTERN.test(row.code)) {
        // Los centros existentes con códigos viejos (no numéricos) se aceptan tal cual; uno nuevo o un código nuevo, no.
        if (!centerByCode.has(row.code) || row.previousCode) {
          centerError(at, CENTER_HEADERS.code, `«${row.code}» no es un código de centro de costo (solo dígitos)`);
          continue;
        }
      }
      if (!row.name) {
        centerError(at, CENTER_HEADERS.name, 'El nombre es obligatorio');
        valid = false;
      } else if (row.name.length > NAME_MAX) {
        centerError(at, CENTER_HEADERS.name, `El nombre admite hasta ${NAME_MAX} caracteres`);
        valid = false;
      }
      const movement = row.movement ? parseMovement(row.movement) : undefined;
      if (row.movement && movement === undefined) {
        centerError(at, CENTER_HEADERS.movement, `Movimiento «${row.movement}»: use 1 (recibe movimientos) o 0 (agrupador)`);
        valid = false;
      }
      const status = row.status ? parseStatus(row.status) : undefined;
      if (row.status && status === undefined) {
        centerError(at, CENTER_HEADERS.status, `Estado desconocido «${row.status}»: Activo o Archivado`);
        valid = false;
      }
      const action: RowAction | undefined = row.action ? parseAction(row.action) : null;
      if (action === undefined) {
        centerError(at, CENTER_HEADERS.action, `Acción desconocida «${row.action ?? ''}»: deje vacío, ELIMINAR o ARCHIVAR`);
        valid = false;
      }
      const previousCode = row.previousCode && row.previousCode !== row.code ? row.previousCode : null;
      let existing = centerByCode.get(row.code);
      if (previousCode) {
        const previous = centerByCode.get(previousCode);
        if (!previous) {
          centerError(at, CENTER_HEADERS.previousCode, `No existe el centro ${previousCode} para pasarlo al código ${row.code}`);
          valid = false;
        } else if (existing) {
          centerError(at, CENTER_HEADERS.code, `El código ${row.code} ya es del centro «${existing.name}»: no se puede recodificar ${previousCode} a ese código`);
          valid = false;
        }
        existing = previous;
      }
      const codeRow = codeRows.get(row.code);
      if (codeRow !== undefined) {
        centerError(at, CENTER_HEADERS.code, `El código ${row.code} ya está en la fila ${codeRow}`);
        valid = false;
      }
      codeRows.set(row.code, at);
      if (!valid) {
        continue;
      }
      if (!existing && action) {
        centerWarning(at, CENTER_HEADERS.action, 'Fila nueva marcada para eliminar o archivar: se ignora');
        continue;
      }
      const key = existing ? existing.id : `${NEW}${row.code}`;
      const previousRow = centerRows.get(key);
      if (previousRow !== undefined) {
        centerError(at, CENTER_HEADERS.previousCode, `El centro ya está en la fila ${previousRow}`);
        continue;
      }
      centerRows.set(key, at);
      if (!isDetailCode(row.code)) {
        centerWarning(at, CENTER_HEADERS.code, `El código ${row.code} no es de cuatro dígitos: no se le deriva centro padre`);
      }
      const current = centers.get(key);
      centers.set(key, {
        key,
        existingId: existing?.id ?? null,
        rowNumber: at,
        code: row.code,
        previousCode: existing && previousCode ? existing.externalCode : null,
        name: row.name ?? '',
        hasMovement: movement ?? current?.hasMovement ?? true,
        isActive: action === 'ARCHIVE' ? false : (status ?? current?.isActive ?? true),
        unitKey: current?.unitKey ?? null,
        parentKey: current?.parentKey ?? null,
        removal: action ?? null,
        activeAssets: existing?.activeAssets ?? 0,
      });
    }
  }

  const isLiveCenter = (center: FinalCenter | undefined): boolean =>
    Boolean(center && center.isActive && center.removal === null);
  const liveCenterByCode = new Map(
    [...centers.values()].filter((center) => isLiveCenter(center)).map((center) => [center.code, center]),
  );

  // Centro propio de las unidades del archivo (antes que los padres: «Depende de» acepta el centro propio del jefe).
  // Los avisos se emiten más abajo, en su orden de siempre.
  const headIssues: Array<{ error: boolean; row: number; message: string }> = [];
  const explicitHead = new Set<string>();
  for (const unit of units.values()) {
    if (unit.rowNumber === null) {
      continue;
    }
    if (unit.headCenterText && isNoneText(unit.headCenterText)) {
      unit.headCenterKey = null;
      continue;
    }
    if (!unit.headCenterText) {
      // Vacío: la existente conserva el suyo. La nueva (o la existente sin centro propio a la que se le cambia el
      // prefijo) con un Prefijo de 4 dígitos que es un centro (1510) toma ese centro; la nueva de prefijo X, X010.
      const before = unit.existingId ? snapshotUnits.get(unit.existingId) : undefined;
      const deducible = !before || (!unit.headCenterKey && before.codePrefix !== unit.codePrefix);
      if (deducible && unit.unitType !== OrgUnitType.Council) {
        const byCode = unit.rawPrefix && isDetailCode(unit.rawPrefix) ? liveCenterByCode.get(unit.rawPrefix) : undefined;
        const byRoot =
          unit.existingId === null && unit.codePrefix?.length === 1 ? liveCenterByCode.get(`${unit.codePrefix}010`) : undefined;
        const deduced = byCode ?? byRoot;
        if (deduced) {
          unit.headCenterKey = deduced.key;
          headIssues.push({ error: false, row: unit.rowNumber, message: `Centro propio deducido: ${deduced.code}` });
        }
      }
      continue;
    }
    if (unit.unitType === OrgUnitType.Council) {
      headIssues.push({ error: true, row: unit.rowNumber, message: 'Un consejo o comité no tiene centro de costo propio' });
      continue;
    }
    const head = liveCenterByCode.get(unit.headCenterText);
    if (!head || !isLiveCenter(head)) {
      headIssues.push({ error: true, row: unit.rowNumber, message: `No hay un centro de costo activo con código ${unit.headCenterText}` });
      continue;
    }
    unit.headCenterKey = head.key;
    explicitHead.add(unit.key);
  }

  // Unidad de cada centro propio (para «Depende de 4010»).
  const unitByHeadCode = new Map<string, FinalUnit>();
  for (const unit of units.values()) {
    const head = unit.headCenterKey ? centers.get(unit.headCenterKey) : undefined;
    if (head && isLiveUnit(unit) && !unitByHeadCode.has(head.code)) {
      unitByHeadCode.set(head.code, unit);
    }
  }


  // Prefijos únicos entre unidades activas al final.
  const finalPrefix = new Map<string, FinalUnit>();
  for (const unit of units.values()) {
    if (!isLiveUnit(unit) || !unit.codePrefix) {
      continue;
    }
    const holder = finalPrefix.get(unit.codePrefix);
    if (holder) {
      const [inFile, other] = unit.rowNumber !== null ? [unit, holder] : [holder, unit];
      const longer = unit.codePrefix.length < 4 ? ` (${unit.codePrefix}1)` : '';
      const usedBy = other.rowNumber !== null ? `la fila ${other.rowNumber} (${other.name})` : `«${other.name}»`;
      unitError(
        inFile.rowNumber ?? 0,
        UNIT_HEADERS.prefix,
        `El prefijo ${unit.codePrefix} ya lo usa ${usedBy}: cada cuadro necesita uno distinto; si es una oficina de ese cuadro, deje el prefijo vacío o use más dígitos${longer}`,
      );
      continue;
    }
    finalPrefix.set(unit.codePrefix, unit);
  }
  const finalUnitByCode = new Map([...units.values()].map((unit) => [unit.code, unit]));

  /**
   * «Depende de» vacío en una unidad nueva: con prefijo de 2+ dígitos, la unidad activa con el prefijo propio más largo
   * (43 → 4; 431 → 43, si no 4); con prefijo de 1 dígito, la Rectoría si hay exactamente una activa; si no, raíz.
   */
  const deduceParent = (unit: FinalUnit): void => {
    const at = unit.rowNumber ?? 0;
    const prefix = unit.codePrefix;
    let parent: FinalUnit | undefined;
    // Una Rectoría nunca se ubica sola bajo otra unidad.
    if (unit.unitType === OrgUnitType.Rectorate) {
      unit.parentKey = null;
      return;
    }
    if (prefix && prefix.length > 1) {
      for (let length = prefix.length - 1; length >= 1 && !parent; length -= 1) {
        parent = finalPrefix.get(prefix.slice(0, length));
      }
      if (parent) {
        unit.parentKey = parent.key;
        unitWarning(at, UNIT_HEADERS.parent, `Depende de deducido del prefijo: ${parent.codePrefix ?? parent.code}`);
        return;
      }
    } else if (prefix) {
      const rectorates = [...units.values()].filter(
        (other) => other.key !== unit.key && other.unitType === OrgUnitType.Rectorate && isLiveUnit(other),
      );
      parent = rectorates.length === 1 ? rectorates[0] : undefined;
      if (parent) {
        unit.parentKey = parent.key;
        unitWarning(at, UNIT_HEADERS.parent, `Depende de deducido: la Rectoría ${parent.codePrefix ?? parent.code}`);
        return;
      }
    }
    unit.parentKey = null;
    unitWarning(at, UNIT_HEADERS.parent, 'Sin Depende de: queda en la raíz');
  };

  // Más de una Rectoría activa: la deducción «un número → la Rectoría» no aplica; se avisa una vez.
  const liveRectorates = [...units.values()].filter((unit) => unit.unitType === OrgUnitType.Rectorate && isLiveUnit(unit));
  const firstRectorateRow = liveRectorates
    .map((unit) => unit.rowNumber)
    .filter((row): row is number => row !== null)
    .sort((left, right) => left - right)[0];
  if (liveRectorates.length > 1 && firstRectorateRow !== undefined) {
    unitWarning(
      firstRectorateRow,
      UNIT_HEADERS.type,
      `Hay ${liveRectorates.length} cuadros de tipo Rectoría (${liveRectorates
        .map((unit) => `${unit.codePrefix ? `${unit.codePrefix} ` : ''}${unit.name}`)
        .join('; ')}): las filas nuevas de un número sin «Depende de» quedan en la raíz`,
    );
  }

  const prefixOwners = [...finalPrefix.values()]
    .filter((unit) => unit.unitType !== OrgUnitType.Council)
    .map((unit) => ({ codePrefix: unit.codePrefix ?? '', unit }));

  /**
   * «Depende de», en orden: prefijo exacto; prefijo normalizado (1200 → 12); código del centro propio de una unidad
   * (4010 → la Vicerrectoría Financiera); código interno.
   */
  const resolveParentText = (text: string): { parent: FinalUnit | undefined; viaHead: boolean } => {
    if (!/^[0-9]+$/.test(text)) {
      return { parent: finalUnitByCode.get(text) ?? finalUnitByCode.get(text.toUpperCase()), viaHead: false };
    }
    const byPrefix = finalPrefix.get(text) ?? finalPrefix.get(normalizeUnitPrefix(text));
    if (byPrefix) {
      return { parent: byPrefix, viaHead: false };
    }
    return { parent: unitByHeadCode.get(text), viaHead: unitByHeadCode.has(text) };
  };

  const unresolvedParentMessage = (text: string): string => {
    if (/^[0-9]+$/.test(text) && liveCenterByCode.has(text)) {
      const owner = resolveCenterUnit(text, prefixOwners)?.unit;
      return `${text} es un centro de costo pero ninguna unidad lo tiene como Centro propio; escriba el prefijo de la unidad${owner?.codePrefix ? `, p. ej. ${owner.codePrefix}` : ''}`;
    }
    return `No hay ninguna unidad activa con prefijo, centro propio o código interno «${text}»`;
  };

  // Padres de las filas del archivo.
  for (const unit of units.values()) {
    if (unit.rowNumber === null) {
      continue;
    }
    const text = unit.parentText;
    if (text && isRootText(text)) {
      unit.parentKey = null;
      continue;
    }
    if (!text) {
      if (unit.existingId === null) {
        deduceParent(unit);
      }
      continue;
    }
    const { parent, viaHead } = resolveParentText(text);
    if (!parent) {
      unitError(unit.rowNumber, UNIT_HEADERS.parent, unresolvedParentMessage(text));
      continue;
    }
    if (parent.key === unit.key) {
      unitError(unit.rowNumber, UNIT_HEADERS.parent, 'Una unidad no puede depender de sí misma');
      continue;
    }
    if (!isLiveUnit(parent) && isLiveUnit(unit)) {
      unitError(unit.rowNumber, UNIT_HEADERS.parent, `«${parent.name}» está archivada o marcada para eliminar`);
      continue;
    }
    unit.parentKey = parent.key;
    if (viaHead) {
      unitWarning(
        unit.rowNumber,
        UNIT_HEADERS.parent,
        `Depende de ${text}: el Centro propio de ${parent.name}${parent.codePrefix ? ` (${parent.codePrefix})` : ''}`,
      );
    }
  }

  // Misma fila que su jefe con otro código (1310 bajo 1300 con el mismo nombre): probablemente es su centro propio.
  for (const unit of units.values()) {
    const parent = unit.parentKey ? units.get(unit.parentKey) : undefined;
    if (unit.rowNumber === null || !parent || normalizeText(parent.name) !== normalizeText(unit.name)) {
      continue;
    }
    const own = unit.rawPrefix ?? unit.codePrefix ?? unit.code;
    const head = parent.rawPrefix ?? parent.codePrefix ?? parent.code;
    unitWarning(unit.rowNumber, UNIT_HEADERS.name, `${own} tiene el mismo nombre que su jefe ${head}; ¿es su Centro propio?`);
  }

  // Ciclos.
  const cyclic = new Set<string>();
  for (const unit of units.values()) {
    if (unit.rowNumber === null) {
      continue;
    }
    let current = unit.parentKey ? units.get(unit.parentKey) : undefined;
    for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
      if (current.key === unit.key) {
        cyclic.add(unit.key);
        unitError(unit.rowNumber, UNIT_HEADERS.parent, 'Esa dependencia forma un ciclo (la unidad quedaría por debajo de sí misma)');
        break;
      }
      current = current.parentKey ? units.get(current.parentKey) : undefined;
    }
  }

  // Prefijo jerárquico y consejos.
  for (const unit of units.values()) {
    if (unit.rowNumber === null || cyclic.has(unit.key) || !isLiveUnit(unit)) {
      continue;
    }
    if (unit.unitType === OrgUnitType.Council && unit.codePrefix) {
      unitError(unit.rowNumber, UNIT_HEADERS.prefix, 'Un consejo o comité no lleva prefijo: no recibe centros de costo');
      continue;
    }
    if (!unit.codePrefix) {
      continue;
    }
    // Jefe con prefijo más cercano y prefijos de toda la cadena hacia arriba (nunca cuentan como «otra unidad»).
    let ancestor: FinalUnit | undefined;
    const chain = new Set<string>();
    let current = unit.parentKey ? units.get(unit.parentKey) : undefined;
    for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
      if (current.codePrefix) {
        ancestor ??= current;
        chain.add(current.codePrefix);
      }
      current = current.parentKey ? units.get(current.parentKey) : undefined;
    }
    const others = new Map(
      [...finalPrefix.entries()]
        .filter(([prefix]) => prefix !== unit.codePrefix)
        .map(([prefix, holder]) => [prefix, holder.name] as const),
    );
    const check = checkUnitPrefix(unit.codePrefix, ancestor?.codePrefix ?? null, others, chain);
    if (check.level === 'OK' || !check.message) {
      continue;
    }
    const before = unit.existingId ? snapshotUnits.get(unit.existingId) : undefined;
    const changed = !before || before.codePrefix !== unit.codePrefix || before.parentId !== unit.parentKey;
    (check.level === 'ERROR' && changed ? unitError : unitWarning)(unit.rowNumber, UNIT_HEADERS.prefix, check.message);
  }

  const prefixedUnits = [...finalPrefix.values()]
    .filter((unit) => !cyclic.has(unit.key) && unit.unitType !== OrgUnitType.Council)
    .map((unit) => ({ codePrefix: unit.codePrefix ?? '', unit }));

  // Unidad y padre derivados, movimiento y archivo de los centros del archivo.
  for (const center of centers.values()) {
    if (center.rowNumber === null) {
      continue;
    }
    const at = center.rowNumber;
    const before = center.existingId ? snapshotCenters.get(center.existingId) : undefined;
    if (center.activeAssets > 0 && (center.removal !== null || !center.isActive)) {
      centerError(at, center.removal ? CENTER_HEADERS.action : CENTER_HEADERS.status, `Tiene ${center.activeAssets} activos asignados: no se puede eliminar ni archivar`);
      continue;
    }
    if (center.activeAssets > 0 && before?.hasMovement && !center.hasMovement) {
      centerError(at, CENTER_HEADERS.movement, `Tiene ${center.activeAssets} activos asignados: no puede quedar como agrupador (0)`);
      continue;
    }
    if (!isLiveCenter(center)) {
      continue;
    }
    const match = resolveCenterUnit(center.code, prefixedUnits);
    if (match) {
      center.unitKey = match.unit.key;
    } else {
      const currentUnit = center.unitKey ? units.get(center.unitKey) : undefined;
      if (center.unitKey && !isLiveUnit(currentUnit)) {
        center.unitKey = null;
      }
      centerWarning(
        at,
        CENTER_HEADERS.unit,
        center.unitKey
          ? `Ninguna unidad tiene un prefijo con que empiece ${center.code}: conserva su unidad «${currentUnit?.name ?? ''}»`
          : `Ninguna unidad tiene un prefijo con que empiece ${center.code}: queda sin unidad`,
      );
    }
    if (isDetailCode(center.code)) {
      const resolution = resolveCenterParent(center.code, (code) => code !== center.code && liveCenterByCode.has(code));
      center.parentKey = resolution.parentCode ? (liveCenterByCode.get(resolution.parentCode)?.key ?? null) : null;
      if (resolution.missingParentCode) {
        centerWarning(
          at,
          CENTER_HEADERS.parent,
          `Le corresponde el centro padre ${resolution.missingParentCode}, que no existe: queda sin padre, en su unidad`,
        );
      }
    } else if (center.parentKey && !isLiveCenter(centers.get(center.parentKey))) {
      center.parentKey = null;
    }
  }

  // Centros marcados para borrar o archivar: hijos activos que no están en el archivo.
  for (const center of centers.values()) {
    if (center.rowNumber === null || (center.removal === null && center.isActive)) {
      continue;
    }
    const children = [...centers.values()].filter(
      (child) => child.key !== center.key && child.parentKey === center.key && isLiveCenter(child),
    );
    if (children.length > 0) {
      centerError(
        center.rowNumber,
        center.removal ? CENTER_HEADERS.action : CENTER_HEADERS.status,
        `Tiene ${children.length} centros hijos activos (${children.map((child) => child.code).join(', ')}): muévalos o márquelos también`,
      );
      continue;
    }
    if (center.removal === 'DELETE' && center.existingId) {
      const history = snapshot.removal.get(center.existingId)?.history ?? null;
      if (history) {
        center.removal = 'ARCHIVE';
        center.isActive = false;
        centerWarning(center.rowNumber, CENTER_HEADERS.action, `No se elimina: ${history}`);
      }
    }
  }

  // Avisos del centro propio.
  for (const issue of headIssues) {
    (issue.error ? unitError : unitWarning)(issue.row, UNIT_HEADERS.headCenter, issue.message);
  }
  for (const unit of units.values()) {
    const head = unit.headCenterKey ? centers.get(unit.headCenterKey) : undefined;
    if (unit.rowNumber !== null && head && explicitHead.has(unit.key) && head.unitKey !== unit.key) {
      unitWarning(unit.rowNumber, UNIT_HEADERS.headCenter, `El centro propio ${head.code} no queda en esta unidad`);
    }
  }

  // Unidades marcadas para borrar o archivar.
  for (const unit of units.values()) {
    if (unit.rowNumber === null || (unit.removal === null && unit.isActive)) {
      continue;
    }
    const before = unit.existingId ? snapshotUnits.get(unit.existingId) : undefined;
    if (!before?.isActive && unit.removal !== 'DELETE') {
      continue;
    }
    const children = [...units.values()].filter((child) => child.parentKey === unit.key && isLiveUnit(child));
    const liveCenters = [...centers.values()].filter((center) => center.unitKey === unit.key && isLiveCenter(center));
    if (children.length > 0 || liveCenters.length > 0) {
      const parts = [
        ...(children.length > 0 ? [`${children.length} unidades hijas activas`] : []),
        ...(liveCenters.length > 0 ? [`${liveCenters.length} centros de costo activos`] : []),
      ];
      unitError(
        unit.rowNumber,
        unit.removal ? UNIT_HEADERS.action : UNIT_HEADERS.status,
        `Tiene ${parts.join(' y ')}: muévalos o márquelos también`,
      );
      continue;
    }
    if (unit.removal === 'DELETE' && unit.existingId) {
      const history = snapshot.removal.get(unit.existingId)?.history ?? null;
      if (history) {
        unit.removal = 'ARCHIVE';
        unit.isActive = false;
        unitWarning(unit.rowNumber, UNIT_HEADERS.action, `No se elimina: ${history}`);
      }
    }
  }

  // ─── Diferencias ───────────────────────────────────────────────────────────────────────────────────────────────
  const unitOps: UnitOp[] = [];
  const centerOps: CenterOp[] = [];
  const changes: PlanChange[] = [];
  const unitCounts = emptyCounts(UNIT_CHANGE_KINDS);
  const centerCounts = emptyCounts(CENTER_CHANGE_KINDS);
  const unitLabel = (key: string | null): string => {
    if (!key) {
      return '(raíz)';
    }
    const unit = units.get(key);
    return unit ? `${unit.codePrefix ?? unit.code} · ${unit.name}` : '?';
  };
  const centerLabel = (key: string | null): string => (key ? (centers.get(key)?.code ?? '?') : '(sin padre)');

  for (const unit of [...units.values()].sort((left, right) => (left.rowNumber ?? 0) - (right.rowNumber ?? 0))) {
    if (unit.rowNumber === null) {
      continue;
    }
    const before = unit.existingId ? snapshotUnits.get(unit.existingId) : undefined;
    const kinds: UnitChangeKind[] = [];
    const details: string[] = [];
    if (!before) {
      kinds.push('CREATED');
      details.push(`Nueva ${ORG_UNIT_TYPE_LABELS[unit.unitType].toLowerCase()} bajo ${unitLabel(unit.parentKey)}`);
    } else if (unit.removal === 'DELETE') {
      kinds.push('DELETED');
      details.push('Se elimina');
    } else {
      if (before.name !== unit.name) {
        kinds.push('RENAMED');
        details.push(`Nombre: «${before.name}» → «${unit.name}»`);
      }
      if (before.unitType !== unit.unitType) {
        kinds.push('RETYPED');
        details.push(`Tipo: ${ORG_UNIT_TYPE_LABELS[before.unitType] ?? before.unitType} → ${ORG_UNIT_TYPE_LABELS[unit.unitType]}`);
      }
      if (before.parentId !== unit.parentKey) {
        kinds.push('MOVED');
        details.push(`Depende de: ${unitLabel(before.parentId)} → ${unitLabel(unit.parentKey)}`);
      }
      if (before.codePrefix !== unit.codePrefix) {
        kinds.push('PREFIX_CHANGED');
        details.push(`Prefijo: ${before.codePrefix ?? '(sin prefijo)'} → ${unit.codePrefix ?? '(sin prefijo)'}`);
      }
      if (before.relationType !== unit.relationType) {
        kinds.push('RELATION_CHANGED');
        details.push(`Línea: ${ORG_RELATION_TYPE_LABELS[before.relationType] ?? before.relationType} → ${ORG_RELATION_TYPE_LABELS[unit.relationType]}`);
      }
      if (before.headCostCenterId !== unit.headCenterKey) {
        kinds.push('HEAD_CHANGED');
        details.push(`Centro propio: ${before.headCostCenterId ? centerLabel(before.headCostCenterId) : '(ninguno)'} → ${unit.headCenterKey ? centerLabel(unit.headCenterKey) : '(ninguno)'}`);
      }
      if (!before.isActive && unit.isActive) {
        kinds.push('REACTIVATED');
        details.push('Se reactiva');
      }
      if (before.isActive && !unit.isActive) {
        kinds.push('ARCHIVED');
        details.push('Se archiva');
      }
    }
    if (kinds.length === 0) {
      continue;
    }
    for (const kind of kinds) {
      unitCounts[kind] += 1;
    }
    unitOps.push({
      key: unit.key,
      existingId: unit.existingId,
      rowNumber: unit.rowNumber,
      code: unit.code,
      name: unit.name,
      unitType: unit.unitType,
      relationType: unit.relationType,
      codePrefix: unit.codePrefix,
      parentKey: unit.parentKey,
      headCenterKey: unit.headCenterKey,
      isActive: unit.isActive,
      removal: unit.removal,
      kinds,
    });
    changes.push({
      sheet: UNIT_SHEET,
      rowNumber: unit.rowNumber,
      entity: 'ORG_UNIT',
      kind: kinds[0] ?? 'CREATED',
      code: unit.codePrefix ?? unit.code,
      name: unit.name,
      detail: details.join('; '),
    });
  }

  for (const center of [...centers.values()].sort((left, right) => (left.rowNumber ?? 0) - (right.rowNumber ?? 0))) {
    if (center.rowNumber === null) {
      continue;
    }
    const before = center.existingId ? snapshotCenters.get(center.existingId) : undefined;
    const kinds: CenterChangeKind[] = [];
    const details: string[] = [];
    if (!before) {
      kinds.push('CREATED');
      details.push(`Nuevo en ${unitLabel(center.unitKey)}${center.parentKey ? `, bajo ${centerLabel(center.parentKey)}` : ''}`);
    } else if (center.removal === 'DELETE') {
      kinds.push('DELETED');
      details.push('Se elimina');
    } else {
      if (before.externalCode !== center.code) {
        kinds.push('RECODED');
        details.push(`Código: ${before.externalCode} → ${center.code} (conserva activos e historia)`);
      }
      if (before.name !== center.name) {
        kinds.push('RENAMED');
        details.push(`Nombre: «${before.name}» → «${center.name}»`);
      }
      if (before.unitId !== center.unitKey || before.parentId !== center.parentKey) {
        kinds.push('RELOCATED');
        details.push(
          [
            ...(before.unitId !== center.unitKey ? [`Unidad: ${unitLabel(before.unitId)} → ${unitLabel(center.unitKey)}`] : []),
            ...(before.parentId !== center.parentKey
              ? [`Padre: ${centerLabel(before.parentId)} → ${centerLabel(center.parentKey)}`]
              : []),
          ].join('; '),
        );
      }
      if (before.hasMovement !== center.hasMovement) {
        kinds.push('MOVEMENT_CHANGED');
        details.push(`Movimiento: ${before.hasMovement ? 1 : 0} → ${center.hasMovement ? 1 : 0}`);
      }
      if (!before.isActive && center.isActive) {
        kinds.push('REACTIVATED');
        details.push('Se reactiva');
      }
      if (before.isActive && !center.isActive) {
        kinds.push('ARCHIVED');
        details.push('Se archiva');
      }
    }
    if (kinds.length === 0) {
      continue;
    }
    for (const kind of kinds) {
      centerCounts[kind] += 1;
    }
    centerOps.push({
      key: center.key,
      existingId: center.existingId,
      rowNumber: center.rowNumber,
      code: center.code,
      previousCode: center.previousCode,
      name: center.name,
      hasMovement: center.hasMovement,
      isActive: center.isActive,
      unitKey: center.unitKey,
      parentKey: center.parentKey,
      removal: center.removal,
      kinds,
    });
    changes.push({
      sheet: CENTER_SHEET,
      rowNumber: center.rowNumber,
      entity: 'COST_CENTER',
      kind: kinds[0] ?? 'CREATED',
      code: center.code,
      name: center.name,
      detail: details.join('; '),
    });
  }

  const hash = createHash('sha256').update(JSON.stringify({ units: unitOps, centers: centerOps })).digest('hex');
  return { units: unitOps, centers: centerOps, changes, errors, warnings, unitCounts, centerCounts, hash };
};
