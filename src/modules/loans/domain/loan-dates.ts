export const LOAN_TIME_ZONE = 'America/Bogota';

export const SQL_BOGOTA_TODAY = `(now() AT TIME ZONE '${LOAN_TIME_ZONE}')::date`;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const bogotaDate = (instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: LOAN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const parse = (iso: string): CalendarDate => {
  const match = ISO_DATE.exec(iso.slice(0, 10));
  if (!match) {
    throw new Error(`Fecha inválida: ${iso}`);
  }
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new Error(`Fecha inválida: ${iso}`);
  }
  return date;
};

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const toUtcMs = (date: CalendarDate): number => Date.UTC(date.year, date.month - 1, date.day);

const addMonths = (date: CalendarDate, months: number): CalendarDate => {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
};

export interface LoanUsage {
  readonly years: number;
  readonly months: number;
  readonly days: number;
  readonly totalDays: number;
  readonly text: string;
}

const unit = (value: number, singular: string, plural: string): string =>
  `${value} ${value === 1 ? singular : plural}`;

export const formatUsage = (usage: Pick<LoanUsage, 'years' | 'months' | 'days'>): string =>
  [
    unit(usage.years, 'año', 'años'),
    unit(usage.months, 'mes', 'meses'),
    unit(usage.days, 'día', 'días'),
  ].join(', ');

export const usageBetween = (from: string, to: string): LoanUsage | null => {
  const start = parse(from);
  const end = parse(to);
  const endMs = toUtcMs(end);
  const totalDays = Math.round((endMs - toUtcMs(start)) / 86_400_000);
  if (totalDays < 0) {
    return null;
  }
  let months = (end.year - start.year) * 12 + (end.month - start.month);
  while (months > 0 && toUtcMs(addMonths(start, months)) > endMs) {
    months -= 1;
  }
  const anchor = addMonths(start, months);
  const days = Math.round((endMs - toUtcMs(anchor)) / 86_400_000);
  const usage = { years: Math.floor(months / 12), months: months % 12, days };
  return { ...usage, totalDays, text: formatUsage(usage) };
};

export const daysOverdue = (expectedReturnDate: string, today: string): number => {
  const days = Math.round((toUtcMs(parse(today)) - toUtcMs(parse(expectedReturnDate))) / 86_400_000);
  return Math.max(0, days);
};

const MONTHS = [
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
];

export const longSpanishDate = (iso: string): string => {
  const date = parse(iso);
  return `${date.day} DE ${MONTHS[date.month - 1]} DE ${date.year}`;
};
