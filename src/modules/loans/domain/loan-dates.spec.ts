import { bogotaDate, daysOverdue, formatUsage, longSpanishDate, usageBetween } from './loan-dates.js';

describe('usageBetween: tiempo de uso del préstamo', () => {
  it('reproduce el ejemplo institucional del OCI-01-65', () => {
    // Acta de ejemplo: entrega 27 de marzo del 2026, devolución estimada 11 de diciembre de 2026.
    expect(usageBetween('2026-03-27', '2026-12-11')?.text).toBe('0 años, 8 meses, 14 días');
  });

  it('mismo día: cero', () => {
    expect(usageBetween('2026-09-25', '2026-09-25')).toEqual({
      years: 0,
      months: 0,
      days: 0,
      totalDays: 0,
      text: '0 años, 0 meses, 0 días',
    });
  });

  it('fin de mes: el día se recorta al último del mes de llegada', () => {
    expect(usageBetween('2026-01-31', '2026-02-28')).toMatchObject({ months: 1, days: 0, totalDays: 28 });
    expect(usageBetween('2026-01-31', '2026-03-01')).toMatchObject({ months: 1, days: 1 });
    expect(usageBetween('2026-01-31', '2026-03-31')).toMatchObject({ months: 2, days: 0 });
    // Con el recorte, 30-ene y 31-ene cumplen un mes el 28-feb.
    expect(usageBetween('2026-01-30', '2026-02-28')).toMatchObject({ months: 1, days: 0 });
    expect(usageBetween('2026-01-30', '2026-02-27')).toMatchObject({ months: 0, days: 28 });
    expect(usageBetween('2026-08-31', '2026-09-30')).toMatchObject({ months: 1, days: 0 });
    expect(usageBetween('2026-12-31', '2027-01-01')).toMatchObject({ years: 0, months: 0, days: 1 });
  });

  it('bisiesto', () => {
    expect(usageBetween('2028-01-31', '2028-02-29')).toMatchObject({ months: 1, days: 0 });
    expect(usageBetween('2028-02-29', '2029-02-28')).toMatchObject({ years: 1, months: 0, days: 0, totalDays: 365 });
    expect(usageBetween('2028-02-28', '2028-03-01')).toMatchObject({ months: 0, days: 2, totalDays: 2 });
    expect(usageBetween('2027-02-28', '2027-03-01')).toMatchObject({ months: 0, days: 1, totalDays: 1 });
    expect(usageBetween('2028-02-29', '2032-02-29')).toMatchObject({ years: 4, months: 0, days: 0 });
  });

  it('años, meses y días juntos; singular en español', () => {
    expect(usageBetween('2025-01-15', '2026-03-16')?.text).toBe('1 año, 2 meses, 1 día');
    expect(formatUsage({ years: 2, months: 1, days: 3 })).toBe('2 años, 1 mes, 3 días');
  });

  it('fin anterior al inicio: null; fechas inválidas lanzan', () => {
    expect(usageBetween('2026-09-25', '2026-09-24')).toBeNull();
    expect(() => usageBetween('2026-02-30', '2026-03-01')).toThrow(/Fecha inválida/);
    expect(() => usageBetween('25/09/2026', '2026-10-01')).toThrow(/Fecha inválida/);
  });
});

describe('daysOverdue', () => {
  it('cuenta días calendario desde la fecha estimada; 0 si aún no vence', () => {
    expect(daysOverdue('2026-09-20', '2026-09-25')).toBe(5);
    expect(daysOverdue('2026-09-25', '2026-09-25')).toBe(0);
    expect(daysOverdue('2026-09-30', '2026-09-25')).toBe(0);
    expect(daysOverdue('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('fechas en America/Bogota', () => {
  it('bogotaDate usa el día de Bogotá, no el UTC', () => {
    // 03:00 UTC del 26 = 22:00 del 25 en Bogotá (UTC-5).
    expect(bogotaDate(new Date('2026-09-26T03:00:00Z'))).toBe('2026-09-25');
    expect(bogotaDate(new Date('2026-09-26T05:00:00Z'))).toBe('2026-09-26');
  });

  it('longSpanishDate escribe la fecha como documento.fecha del motor de actas', () => {
    // Misma expresión que DocumentEngineService.longDate (no exportada).
    const engineLongDate = (date: Date): string =>
      new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
        .format(date)
        .replaceAll(' de ', ' DE ')
        .toUpperCase();
    for (let month = 1; month <= 12; month += 1) {
      const iso = `2026-${String(month).padStart(2, '0')}-0${(month % 9) + 1}`;
      expect(longSpanishDate(iso)).toBe(engineLongDate(new Date(`${iso}T12:00:00-05:00`)));
    }
    expect(longSpanishDate('2026-12-11')).toBe('11 DE DICIEMBRE DE 2026');
  });
});
