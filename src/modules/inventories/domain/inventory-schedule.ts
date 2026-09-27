/**
 * Reglas puras de la programación de tomas físicas: recordatorios, cruce de fechas, semanas ISO, cobertura y
 * enmascarado de correos. Las fechas de la toma son fechas calendario (YYYY-MM-DD) de America/Bogota.
 */

/** Recordatorios por defecto: 30, 15 y 1 día antes del inicio. */
export const DEFAULT_REMINDER_OFFSETS_DAYS: ReadonlyArray<number> = [30, 15, 1];
export const MAX_REMINDER_OFFSETS = 6;
export const MAX_REMINDER_OFFSET_DAYS = 365;

/**
 * Hora fija de envío: 07:00 de Bogotá del día (inicio - offset). Colombia no tiene horario de verano desde 1993,
 * así que el desfase es siempre -05:00 (el mismo que usa `AT TIME ZONE 'America/Bogota'` en PostgreSQL).
 */
export const REMINDER_SEND_HOUR_BOGOTA = 7;
const BOGOTA_OFFSET = '-05:00';

/** Máximo de días que abarca una consulta del calendario (tres meses). */
export const MAX_CALENDAR_DAYS = 93;

export const REMINDER_STATUSES = ['PENDING', 'SENT', 'SKIPPED', 'CANCELLED', 'NO_RECIPIENT', 'SUPERSEDED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const toUtcMs = (date: string): number => {
  const match = ISO_DATE.exec(date.slice(0, 10));
  if (!match) {
    throw new Error(`Fecha inválida: ${date}`);
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

const fromUtcMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

export const addDays = (date: string, days: number): string => fromUtcMs(toUtcMs(date) + days * DAY_MS);

/** Días calendario de `from` a `to` (negativo si `to` es anterior). */
export const daysBetween = (from: string, to: string): number => Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);

/** YYYY-MM-DD de un instante en Bogotá. */
export const bogotaDate = (instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

/** Instante en que vence el recordatorio de `offsetDays` días antes de `plannedStartDate`. */
export const reminderDueAt = (plannedStartDate: string, offsetDays: number): Date => {
  const day = addDays(plannedStartDate, -offsetDays);
  const hour = String(REMINDER_SEND_HOUR_BOGOTA).padStart(2, '0');
  return new Date(`${day}T${hour}:00:00${BOGOTA_OFFSET}`);
};

export interface PlannedReminder {
  readonly offsetDays: number;
  readonly dueAt: Date;
  /** SKIPPED: su momento ya pasó al programar; no se envía nunca. */
  readonly status: Extract<ReminderStatus, 'PENDING' | 'SKIPPED'>;
}

/** Recordatorios de una programación, del más lejano al más cercano al inicio. */
export const planReminders = (
  plannedStartDate: string,
  offsets: ReadonlyArray<number>,
  now: Date,
): ReadonlyArray<PlannedReminder> =>
  [...new Set(offsets)]
    .sort((left, right) => right - left)
    .map((offsetDays) => {
      const dueAt = reminderDueAt(plannedStartDate, offsetDays);
      return { offsetDays, dueAt, status: dueAt.getTime() <= now.getTime() ? 'SKIPPED' : 'PENDING' };
    });

/** Dos rangos de fechas calendario (inclusivos) se cruzan si comparten al menos un día. */
export const dateRangesOverlap = (
  left: { readonly start: string; readonly end: string },
  right: { readonly start: string; readonly end: string },
): boolean => left.start <= right.end && right.start <= left.end;

/** `juliana.perez@unac.edu.co` → `j***@unac.edu.co`. Nunca devuelve el correo completo. */
export const maskEmail = (email: string | null): string | null => {
  const value = email?.trim() ?? '';
  const at = value.lastIndexOf('@');
  if (at < 1) {
    return value === '' ? null : '***';
  }
  return `${value.slice(0, 1)}***${value.slice(at)}`;
};

export interface IsoWeek {
  /** 2026-W41 */
  readonly key: string;
  /** Lunes. */
  readonly start: string;
  /** Domingo. */
  readonly end: string;
}

/** Semana ISO (lunes a domingo) que contiene la fecha. */
export const isoWeekOf = (date: string): IsoWeek => {
  const ms = toUtcMs(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // lunes = 0
  const start = fromUtcMs(ms - weekday * DAY_MS);
  // La semana ISO pertenece al año de su jueves; la semana 1 es la que tiene el primer jueves del año.
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return { key: `${year}-W${String(week).padStart(2, '0')}`, start, end: addDays(start, 6) };
};

/** Semanas ISO que tocan la ventana [from, to]. */
export const isoWeeksBetween = (from: string, to: string): ReadonlyArray<IsoWeek> => {
  const weeks: IsoWeek[] = [];
  let cursor = isoWeekOf(from);
  while (cursor.start <= to) {
    weeks.push(cursor);
    cursor = isoWeekOf(addDays(cursor.start, 7));
  }
  return weeks;
};

export interface WeekLoad {
  readonly week: IsoWeek;
  readonly inventoryIds: ReadonlyArray<string>;
}

/**
 * Semanas en que el número de tomas cuyo rango toca la semana SUPERA el umbral. Sin umbral (null) no hay alertas:
 * el número lo define Control Interno por configuración, no el código.
 */
export const weekConcentration = (
  items: ReadonlyArray<{ readonly id: string; readonly start: string; readonly end: string }>,
  from: string,
  to: string,
  threshold: number | null,
): ReadonlyArray<WeekLoad> => {
  if (threshold === null) {
    return [];
  }
  return isoWeeksBetween(from, to)
    .map((week) => ({
      week,
      inventoryIds: items
        .filter((item) => dateRangesOverlap({ start: item.start, end: item.end }, week))
        .map((item) => item.id),
    }))
    .filter((load) => load.inventoryIds.length > threshold);
};

export interface CoverageSortKey {
  readonly code: string;
  readonly daysSinceLast: number | null;
  readonly expected: number | null;
  readonly notFound: number | null;
}

/** Tasa de no encontrados de la última toma; null si nunca se revisó o no esperaba activos. */
export const notFoundRate = (row: Pick<CoverageSortKey, 'expected' | 'notFound'>): number | null =>
  row.expected === null || row.notFound === null || row.expected <= 0 ? null : row.notFound / row.expected;

/**
 * Orden de cobertura: primero los centros nunca revisados, luego los de más días desde la última toma y, a igual
 * número de días, los de peor tasa de no encontrados. Desempate estable por código.
 */
export const compareCoverage = (left: CoverageSortKey, right: CoverageSortKey): number => {
  const leftNever = left.daysSinceLast === null;
  const rightNever = right.daysSinceLast === null;
  if (leftNever !== rightNever) {
    return leftNever ? -1 : 1;
  }
  if (!leftNever && !rightNever && left.daysSinceLast !== right.daysSinceLast) {
    return (right.daysSinceLast ?? 0) - (left.daysSinceLast ?? 0);
  }
  const leftRate = notFoundRate(left) ?? -1;
  const rightRate = notFoundRate(right) ?? -1;
  if (leftRate !== rightRate) {
    return rightRate - leftRate;
  }
  return left.code.localeCompare(right.code);
};
