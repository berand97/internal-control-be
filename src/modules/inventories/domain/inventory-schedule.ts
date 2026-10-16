export const DEFAULT_REMINDER_OFFSETS_DAYS: ReadonlyArray<number> = [30, 15, 1];
export const MAX_REMINDER_OFFSETS = 6;
export const MAX_REMINDER_OFFSET_DAYS = 365;

export const REMINDER_SEND_HOUR_BOGOTA = 7;
const BOGOTA_OFFSET = '-05:00';

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

export const daysBetween = (from: string, to: string): number => Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);

export const bogotaDate = (instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

export const reminderDueAt = (plannedStartDate: string, offsetDays: number): Date => {
  const day = addDays(plannedStartDate, -offsetDays);
  const hour = String(REMINDER_SEND_HOUR_BOGOTA).padStart(2, '0');
  return new Date(`${day}T${hour}:00:00${BOGOTA_OFFSET}`);
};

export interface PlannedReminder {
  readonly offsetDays: number;
  readonly dueAt: Date;
  readonly status: Extract<ReminderStatus, 'PENDING' | 'SKIPPED'>;
}

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

export const dateRangesOverlap = (
  left: { readonly start: string; readonly end: string },
  right: { readonly start: string; readonly end: string },
): boolean => left.start <= right.end && right.start <= left.end;

export const maskEmail = (email: string | null): string | null => {
  const value = email?.trim() ?? '';
  const at = value.lastIndexOf('@');
  if (at < 1) {
    return value === '' ? null : '***';
  }
  return `${value.slice(0, 1)}***${value.slice(at)}`;
};

export interface IsoWeek {
  readonly key: string;
  readonly start: string;
  readonly end: string;
}

export const isoWeekOf = (date: string): IsoWeek => {
  const ms = toUtcMs(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  const start = fromUtcMs(ms - weekday * DAY_MS);
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return { key: `${year}-W${String(week).padStart(2, '0')}`, start, end: addDays(start, 6) };
};

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

export const notFoundRate = (row: Pick<CoverageSortKey, 'expected' | 'notFound'>): number | null =>
  row.expected === null || row.notFound === null || row.expected <= 0 ? null : row.notFound / row.expected;

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
