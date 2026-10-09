import { normalizeUnitPrefix } from '../../cost-centers/domain/org-chart-rules.js';
import type { OrgHistoryField } from '../../cost-centers/services/org-structure-history.service.js';
import { orgChartExportRows } from './org-chart-export.js';
import type { RowIssue } from './org-chart-plan.js';
import {
  fingerprint,
  LATER_STAMP_COLUMNS,
  rowValues,
  sameValue,
  STAMP_COLUMN_HEADERS,
  STAMP_COLUMNS,
  type StampColumn,
  type StampRow,
  type StampValues,
  structureRevision,
} from './org-chart-stamp.js';
import { exportValues, TEMPLATE_EXAMPLE } from './org-chart-workbook.js';
import {
  normalizeText,
  type OrgChartInput,
  parseStatus,
  type SnapshotCenter,
  type SnapshotUnit,
  UNIT_HEADERS,
  UNIT_SHEET,
  type UnitRowInput,
} from './org-chart.types.js';

/**
 * Archivos viejos del organigrama: se ajustan las filas ANTES del plan (planOrgChart no cambia), con el sello oculto
 * del archivo (org-chart-stamp.ts) y lo que dice el historial.
 *
 * Con sello, merge de tres vías por columna de cada fila con Código interno (original = huella del sello; archivo; base
 * = el sistema hoy):
 * - archivo = original (no la tocó) → se conserva lo del sistema, aunque haya cambiado después de la descarga;
 * - archivo = base → nada que hacer (también si la misma persona ya lo aplicó y lo vuelve a subir);
 * - tocada y base = original → se aplica;
 * - tocada, base ≠ original y archivo ≠ base → CONFLICTO (error de fila: hay que descargar de nuevo).
 * Una fila sin columnas que aplicar y sin Acción se descarta (0 cambios).
 * Color: vacío (o un archivo sin la columna) nunca cambia nada ni choca; un sello anterior a la columna no trae su
 * huella y el Color se aplica si dice algo distinto del sistema.
 *
 * Con o sin sello:
 * - Código interno que ya no existe (unidad eliminada) → advertencia y no se crea.
 * - Archivada que el archivo dice Activo: sin sello solo se reactiva si se archivó ANTES de la fecha del archivo.
 * - Fila nueva (sin Código interno) igual a una unidad activa (mismo prefijo, o sin prefijo: mismo nombre bajo el mismo
 *   jefe) → se toma como esa unidad, con advertencia.
 * - La fila de ejemplo de la plantilla vieja (4 Vicerrectoría Financiera, 4010) se ignora.
 */

export interface ChangeInfo {
  /** ISO. */
  readonly at: string;
  readonly byName: string | null;
}

export interface DeletedUnitInfo extends ChangeInfo {
  readonly name: string | null;
}

export interface MergeContext {
  readonly units: ReadonlyArray<SnapshotUnit>;
  readonly centers: ReadonlyArray<SnapshotCenter>;
  /** Último cambio de cada campo de cada unidad (org_structure_history), por id de unidad. */
  readonly lastChanges: ReadonlyMap<string, ReadonlyMap<OrgHistoryField, ChangeInfo>>;
  /** Unidades eliminadas físicamente, por Código interno. */
  readonly deletedUnits: ReadonlyMap<string, DeletedUnitInfo>;
  /** Creación de cada unidad, por id. */
  readonly unitOrigins: ReadonlyMap<string, ChangeInfo>;
  readonly now: Date;
}

export interface OrgChartConflict {
  readonly rowNumber: number;
  readonly unitName: string;
  /** Encabezado de la columna. */
  readonly column: string;
  readonly fileValue: string | null;
  readonly currentValue: string | null;
  /** ISO; null si el historial no registra el cambio (p. ej. cambió el prefijo del jefe). */
  readonly changedAt: string | null;
  readonly changedBy: string | null;
}

export interface MergeResult {
  readonly input: OrgChartInput;
  readonly errors: ReadonlyArray<RowIssue>;
  readonly warnings: ReadonlyArray<RowIssue>;
  readonly conflicts: ReadonlyArray<OrgChartConflict>;
  /** Días desde la descarga (según el sello); null sin sello. */
  readonly fileAgeDays: number | null;
}

export const STALE_FILE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_FIELD: Readonly<Record<StampColumn, OrgHistoryField>> = {
  prefix: 'PREFIX',
  name: 'NAME',
  type: 'TYPE',
  parent: 'PARENT',
  relation: 'RELATION',
  headCenter: 'HEAD_COST_CENTER',
  status: 'STATUS',
  color: 'COLOR',
};

const WHEN = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Bogota',
});

const DAY = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Bogota' });

export const formatWhen = (iso: string): string => WHEN.format(new Date(iso));
const formatDay = (iso: string): string => DAY.format(new Date(iso));

const byWhom = (info: ChangeInfo): string => (info.byName ? ` por ${info.byName}` : '');
const shown = (value: string | null): string => (value && value.trim() !== '' ? `«${value}»` : '(vacío)');

/** Valor que deja la columna «como está en el sistema» al planear: vacío conserva; el Nombre es obligatorio. */
const keepValue = (column: StampColumn, unit: SnapshotUnit): string | null => (column === 'name' ? unit.name : null);

const withValues = (row: UnitRowInput, values: Partial<Record<StampColumn, string | null>>): UnitRowInput => ({
  ...row,
  ...values,
});

const isTemplateExample = (row: UnitRowInput): boolean =>
  row.code === null &&
  row.action === null &&
  STAMP_COLUMNS.every(
    (column) =>
      sameValue(column, row[column], TEMPLATE_EXAMPLE[column]) ||
      // Estado vacío en la fila de ejemplo también es la fila de ejemplo.
      (column === 'status' && row.status === null),
  );

export const mergeOrgChartInput = (input: OrgChartInput, context: MergeContext): MergeResult => {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const conflicts: OrgChartConflict[] = [];
  const warn = (rowNumber: number, column: string | null, message: string) =>
    warnings.push({ sheet: UNIT_SHEET, rowNumber, column, message });
  const fail = (rowNumber: number, column: string | null, message: string) =>
    errors.push({ sheet: UNIT_SHEET, rowNumber, column, message });

  const stamp = input.stamp ?? null;
  const fileDate = stamp?.exportedAt ?? input.fileCreatedAt ?? null;
  const fileAgeDays = stamp ? Math.max(0, Math.floor((context.now.getTime() - Date.parse(stamp.exportedAt)) / DAY_MS)) : null;
  if (fileAgeDays !== null && fileAgeDays > STALE_FILE_DAYS) {
    warn(1, null, `Este archivo se descargó hace ${fileAgeDays} días (${formatDay(stamp?.exportedAt ?? '')}): si otras personas cambiaron el organigrama, descargue la versión actual`);
  }
  if (input.invalidStamp) {
    warn(1, null, 'El sello oculto del archivo está dañado: se trata como un archivo sin sello');
  }

  const unitByCode = new Map(context.units.map((unit) => [unit.code, unit]));
  const findByCode = (code: string): SnapshotUnit | undefined => unitByCode.get(code) ?? unitByCode.get(code.toUpperCase());
  const activeUnits = context.units.filter((unit) => unit.isActive);
  const activeByPrefix = new Map(activeUnits.filter((unit) => unit.codePrefix).map((unit) => [unit.codePrefix ?? '', unit]));
  const activeByHead = new Map(
    activeUnits.filter((unit) => unit.headCostCenterCode).map((unit) => [unit.headCostCenterCode ?? '', unit]),
  );
  const exportRows = orgChartExportRows(context.units, context.centers);
  const currentByCode = new Map(exportRows.filter((row) => row.code).map((row) => [row.code ?? '', exportValues(row)]));
  const stampByCode = new Map<string, StampRow>((stamp?.rows ?? []).map((row) => [row.code, row]));
  const unchangedSinceStamp = stamp !== null && stamp.revision === structureRevision(context.units);
  const codesInFile = new Set(
    input.units.flatMap((row) => {
      const existing = row.code ? findByCode(row.code) : undefined;
      return existing ? [existing.code] : [];
    }),
  );

  const createdNote = (unit: SnapshotUnit): string => {
    const origin = context.unitOrigins.get(unit.id);
    return origin ? ` (creada el ${formatDay(origin.at)}${byWhom(origin)})` : '';
  };

  /** «Depende de» de una fila nueva contra el sistema: null raíz; undefined si no se reconoce. */
  const resolveParentId = (text: string | null): string | null | undefined => {
    if (!text || normalizeText(text) === 'raiz') {
      return null;
    }
    if (/^[0-9]+$/.test(text)) {
      return (activeByPrefix.get(text) ?? activeByPrefix.get(normalizeUnitPrefix(text)) ?? activeByHead.get(text))?.id;
    }
    return findByCode(text)?.id;
  };

  /** Archivada que el archivo dice Activo (sin huella que diga que la persona la reactivó): ¿se reactiva? */
  const archivedGuard = (row: UnitRowInput, unit: SnapshotUnit): UnitRowInput => {
    if (unit.isActive || !row.status || parseStatus(row.status) !== true || row.action) {
      return row;
    }
    const archived = context.lastChanges.get(unit.id)?.get('STATUS');
    if (archived && fileDate && Date.parse(archived.at) < Date.parse(fileDate)) {
      return row;
    }
    warn(
      row.rowNumber,
      UNIT_HEADERS.status,
      !fileDate
        ? `«${unit.name}» está archivada y el archivo no dice cuándo se hizo: no se reactiva. Para reactivarla descargue el organigrama actual y cambie allí su Estado`
        : archived
          ? `«${unit.name}» se archivó el ${formatWhen(archived.at)}${byWhom(archived)}, después de que se hizo este archivo: no se reactiva. Para reactivarla descargue el organigrama actual y cambie allí su Estado`
          : `«${unit.name}» está archivada y no se sabe desde cuándo: no se reactiva. Para reactivarla descargue el organigrama actual y cambie allí su Estado`,
    );
    return { ...row, status: null };
  };

  /** Merge de tres vías de una fila con sello; null si no queda nada que aplicar. */
  const mergeStamped = (row: UnitRowInput, unit: SnapshotUnit, original: StampRow): UnitRowInput | null => {
    const file = rowValues(row);
    const current: StampValues = currentByCode.get(unit.code) ?? file;
    const merged: Partial<Record<StampColumn, string | null>> = {};
    let applies = false;
    for (const column of STAMP_COLUMNS) {
      const originalPrint = original.columns[column] ?? '';
      if (column === 'color' && file.color === null) {
        merged.color = null;
        continue;
      }
      if (LATER_STAMP_COLUMNS.has(column) && originalPrint === '') {
        if (sameValue(column, file[column], current[column])) {
          merged[column] = keepValue(column, unit);
        } else {
          applies = true;
        }
        continue;
      }
      const touched = fingerprint(column, file[column]) !== originalPrint;
      const equalsBase = sameValue(column, file[column], current[column]);
      const baseChanged = !unchangedSinceStamp && fingerprint(column, current[column]) !== originalPrint;
      if (!touched || equalsBase) {
        merged[column] = keepValue(column, unit);
        continue;
      }
      if (!baseChanged) {
        applies = true;
        continue;
      }
      merged[column] = keepValue(column, unit);
      const change = context.lastChanges.get(unit.id)?.get(HISTORY_FIELD[column]);
      const header = STAMP_COLUMN_HEADERS[column];
      conflicts.push({
        rowNumber: row.rowNumber,
        unitName: unit.name,
        column: header,
        fileValue: file[column],
        currentValue: current[column],
        changedAt: change?.at ?? null,
        changedBy: change?.byName ?? null,
      });
      fail(
        row.rowNumber,
        header,
        change
          ? `${header} de «${unit.name}»: otra persona lo cambió el ${formatWhen(change.at)}${byWhom(change)} a ${shown(current[column])}; su archivo dice ${shown(file[column])}. Descargue el organigrama de nuevo y repita su cambio`
          : `${header} de «${unit.name}»: cambió en el sistema a ${shown(current[column])} después de que descargó este archivo; su archivo dice ${shown(file[column])}. Descargue el organigrama de nuevo y repita su cambio`,
      );
    }
    if (!applies && row.action === null) {
      return null;
    }
    return withValues(row, merged);
  };

  const units: UnitRowInput[] = [];
  let stamplessCodes = 0;
  for (const row of input.units) {
    if (isTemplateExample(row)) {
      warn(row.rowNumber, null, 'Es la fila de ejemplo de la plantilla: se ignora');
      continue;
    }
    if (row.code) {
      const unit = findByCode(row.code);
      if (!unit) {
        const deleted = context.deletedUnits.get(row.code) ?? context.deletedUnits.get(row.code.toUpperCase());
        warn(
          row.rowNumber,
          UNIT_HEADERS.code,
          deleted
            ? `«${deleted.name ?? row.name ?? row.code}» se eliminó el ${formatWhen(deleted.at)}${byWhom(deleted)}: no se vuelve a crear. Para crearla de nuevo borre su Código interno`
            : `No hay ninguna unidad con Código interno ${row.code} (pudo eliminarse): no se crea. Para crearla como nueva borre su Código interno`,
        );
        continue;
      }
      const original = stampByCode.get(unit.code);
      if (original) {
        const merged = mergeStamped(row, unit, original);
        if (merged) {
          units.push(merged);
        }
        continue;
      }
      stamplessCodes += 1;
      units.push(archivedGuard(row, unit));
      continue;
    }
    // Fila nueva: ¿ya existe?
    const prefix = row.prefix && /^[0-9]{1,4}$/.test(row.prefix) ? row.prefix : null;
    if (prefix) {
      const existing = activeByPrefix.get(prefix) ?? activeByPrefix.get(normalizeUnitPrefix(prefix));
      if (existing) {
        warn(
          row.rowNumber,
          UNIT_HEADERS.prefix,
          `El prefijo ${prefix} ya existe: «${existing.name}»${createdNote(existing)}. La fila se toma como esa unidad`,
        );
      }
      units.push(row);
      continue;
    }
    if (row.name && row.prefix === null && row.action === null) {
      const parentId = resolveParentId(row.parent);
      const name = normalizeText(row.name);
      const existing =
        parentId === undefined
          ? undefined
          : activeUnits.find((unit) => unit.parentId === parentId && normalizeText(unit.name) === name);
      if (existing && !codesInFile.has(existing.code)) {
        codesInFile.add(existing.code);
        warn(
          row.rowNumber,
          UNIT_HEADERS.name,
          `«${existing.name}» ya existe bajo el mismo jefe${createdNote(existing)}: la fila se toma como esa unidad. Si es otra, use un nombre distinto`,
        );
        units.push({ ...row, code: existing.code });
        continue;
      }
    }
    units.push(row);
  }
  if (!stamp && stamplessCodes > 0) {
    warn(
      1,
      null,
      'Este archivo no trae el sello de la descarga (se descargó antes de esta versión o se armó a mano): las filas con Código interno se aplican tal como vienen, aunque otra persona haya cambiado esas unidades después. Para no deshacer cambios ajenos, descargue el organigrama actual',
    );
  }
  return { input: { ...input, units }, errors, warnings, conflicts, fileAgeDays };
};
