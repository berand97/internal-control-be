export const LOCALE_TIME_ZONE = 'America/Bogota';

export const localeIsoDate = (instant: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCALE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

export const localeDateTime = (instant: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: LOCALE_TIME_ZONE,
  }).format(instant);
