import { normalizeUnitPrefix } from '../../cost-centers/domain/org-chart-rules.js';
import { existingSiblingText, unitPlace } from '../domain/unit-name.js';
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

export interface ChangeInfo {
  readonly at: string;
  readonly byName: string | null;
}

export interface DeletedUnitInfo extends ChangeInfo {
  readonly name: string | null;
}

export interface MergeContext {
  readonly units: ReadonlyArray<SnapshotUnit>;
  readonly centers: ReadonlyArray<SnapshotCenter>;
  readonly lastChanges: ReadonlyMap<string, ReadonlyMap<OrgHistoryField, ChangeInfo>>;
  readonly deletedUnits: ReadonlyMap<string, DeletedUnitInfo>;
  readonly unitOrigins: ReadonlyMap<string, ChangeInfo>;
  readonly now: Date;
}

export interface OrgChartConflict {
  readonly rowNumber: number;
  readonly unitName: string;
  readonly column: string;
  readonly fileValue: string | null;
  readonly currentValue: string | null;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
}

export interface MergeResult {
  readonly input: OrgChartInput;
  readonly errors: ReadonlyArray<RowIssue>;
  readonly warnings: ReadonlyArray<RowIssue>;
  readonly conflicts: ReadonlyArray<OrgChartConflict>;
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
const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '(vacío)');

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
    warn(
      1,
      null,
      `Este archivo se descargó hace ${fileAgeDays} días, el ${formatDay(stamp?.exportedAt ?? '')}. Si alguien cambió el organigrama desde entonces, descargue la versión actual.`,
    );
  }
  if (input.invalidStamp) {
    warn(1, null, 'El sello oculto del archivo está dañado. Se revisará como un archivo sin sello.');
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
  const createdText = (unit: SnapshotUnit): string | null => {
    const origin = context.unitOrigins.get(unit.id);
    return origin ? `creada el ${formatDay(origin.at)}${byWhom(origin)}` : null;
  };
  const createdNote = (unit: SnapshotUnit): string => {
    const text = createdText(unit);
    return text ? ` (${text})` : '';
  };
  const unitById = new Map(context.units.map((unit) => [unit.id, unit]));
  const parentName = (parentId: string | null): string | null => (parentId ? (unitById.get(parentId)?.name ?? null) : null);
  const fileRowByCode = new Map<string, UnitRowInput>();
  for (const row of input.units) {
    const existing = row.code ? findByCode(row.code) : undefined;
    if (existing && !fileRowByCode.has(existing.code)) {
      fileRowByCode.set(existing.code, row);
    }
  }

  const resolveParentId = (text: string | null): string | null | undefined => {
    if (!text || normalizeText(text) === 'raiz') {
      return null;
    }
    if (/^[0-9]+$/.test(text)) {
      return (activeByPrefix.get(text) ?? activeByPrefix.get(normalizeUnitPrefix(text)) ?? activeByHead.get(text))?.id;
    }
    return findByCode(text)?.id;
  };

  const leavesPlace = (unit: SnapshotUnit): boolean => {
    const row = fileRowByCode.get(unit.code);
    if (!row) {
      return false;
    }
    const original = stampByCode.get(unit.code);
    const touched = (column: StampColumn): boolean =>
      !original || fingerprint(column, row[column]) !== (original.columns[column] ?? '');
    if (row.action) {
      return true;
    }
    if (row.status && touched('status') && parseStatus(row.status) === false) {
      return true;
    }
    if (row.name && touched('name') && normalizeText(row.name) !== normalizeText(unit.name)) {
      return true;
    }
    return Boolean(row.parent) && touched('parent') && resolveParentId(row.parent) !== unit.parentId;
  };

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
        ? `${unit.name} está archivada y no se reactiva. Para reactivarla, descargue el organigrama actual y cambie el Estado.`
        : archived
          ? `${unit.name} se archivó el ${formatWhen(archived.at)}${byWhom(archived)}, después de que se descargó este archivo. No se reactiva. Para reactivarla, descargue el organigrama actual y cambie el Estado.`
          : `${unit.name} está archivada y no se reactiva. Para reactivarla, descargue el organigrama actual y cambie el Estado.`,
    );
    return { ...row, status: null };
  };

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
          ? `El ${formatWhen(change.at)}${byWhom(change)} se cambió la columna ${header} de ${unit.name} a ${shown(current[column])}. Su archivo dice ${shown(file[column])}. Descargue el organigrama de nuevo y repita su cambio.`
          : `La columna ${header} de ${unit.name} cambió a ${shown(current[column])} después de que descargó este archivo. Su archivo dice ${shown(file[column])}. Descargue el organigrama de nuevo y repita su cambio.`,
      );
    }
    if (!applies && row.action === null) {
      return null;
    }
    return withValues(row, merged);
  };

  const units: UnitRowInput[] = [];
  let stamplessCodes = 0;
  const newRowBySibling = new Map<string, { readonly rowNumber: number; readonly name: string }>();
  for (const row of input.units) {
    if (isTemplateExample(row)) {
      warn(row.rowNumber, null, 'Es la fila de ejemplo de la plantilla. Se ignora.');
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
            ? `${deleted.name ?? row.name ?? row.code} se eliminó el ${formatWhen(deleted.at)}${byWhom(deleted)}. No se vuelve a crear. Para crearla de nuevo, borre su código interno.`
            : `No hay ninguna dependencia con el código interno ${row.code}. Para crearla como nueva, borre su código interno.`,
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
    const prefix = row.prefix && /^[0-9]{1,4}$/.test(row.prefix) ? row.prefix : null;
    if (prefix) {
      const existing = activeByPrefix.get(prefix) ?? activeByPrefix.get(normalizeUnitPrefix(prefix));
      if (existing) {
        warn(
          row.rowNumber,
          UNIT_HEADERS.prefix,
          `El prefijo ${prefix} ya es de ${existing.name}${createdNote(existing)}. La fila se toma como esa dependencia.`,
        );
      }
      units.push(row);
      continue;
    }
    if (row.name && row.prefix === null && row.action === null) {
      const parentId = resolveParentId(row.parent);
      const name = normalizeText(row.name);
      const siblingKey = `${parentId === undefined ? `text:${normalizeText(row.parent ?? '')}` : `id:${parentId ?? ''}`}|${name}`;
      const earlier = newRowBySibling.get(siblingKey);
      if (earlier !== undefined) {
        const place = unitPlace(parentId === undefined ? row.parent : parentName(parentId));
        fail(
          row.rowNumber,
          UNIT_HEADERS.name,
          `La fila ${earlier.rowNumber} ya crea ${earlier.name} ${place}. Si es la misma, borre esta fila. Si es otra, póngale prefijo o un nombre distinto.`,
        );
        continue;
      }
      const existing =
        parentId === undefined
          ? undefined
          : activeUnits.find((unit) => unit.parentId === parentId && normalizeText(unit.name) === name && !leavesPlace(unit));
      if (existing) {
        const created = createdText(existing);
        const origin = context.unitOrigins.get(existing.id);
        const afterFile = origin && fileDate && Date.parse(origin.at) >= Date.parse(fileDate);
        fail(
          row.rowNumber,
          UNIT_HEADERS.name,
          `${existingSiblingText(existing, parentName(existing.parentId), created ? [created] : [])}. ` +
            `Si es la misma, copie su código interno ${existing.code} en la fila. Si es otra, póngale prefijo o un nombre distinto.` +
            (afterFile ? ' Se creó después de que se descargó este archivo. Si ya lo subió antes, esta fila ya está aplicada.' : ''),
        );
        continue;
      }
      newRowBySibling.set(siblingKey, { rowNumber: row.rowNumber, name: row.name });
    }
    units.push(row);
  }
  if (!stamp && stamplessCodes > 0) {
    warn(
      1,
      null,
      'Este archivo no tiene el sello de descarga. Las filas con código interno se aplican tal como vienen y pueden deshacer cambios de otras personas. Para evitarlo, descargue el organigrama actual.',
    );
  }
  return { input: { ...input, units }, errors, warnings, conflicts, fileAgeDays };
};
