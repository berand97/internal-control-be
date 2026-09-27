import { describe, expect, it } from 'vitest';
import {
  addDays,
  compareCoverage,
  dateRangesOverlap,
  daysBetween,
  isoWeekOf,
  isoWeeksBetween,
  maskEmail,
  planReminders,
  reminderDueAt,
  weekConcentration,
} from './inventory-schedule.js';

describe('recordatorios de toma: vencimiento en Bogotá', () => {
  it('vence a las 07:00 de Bogotá (12:00 UTC) del día inicio - offset', () => {
    expect(reminderDueAt('2026-10-19', 30).toISOString()).toBe('2026-09-19T12:00:00.000Z');
    expect(reminderDueAt('2026-10-19', 15).toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(reminderDueAt('2026-10-19', 1).toISOString()).toBe('2026-10-18T12:00:00.000Z');
    expect(reminderDueAt('2026-10-19', 0).toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });

  it('cruza meses y años bisiestos por fecha calendario', () => {
    expect(reminderDueAt('2028-03-01', 1).toISOString()).toBe('2028-02-29T12:00:00.000Z');
    expect(reminderDueAt('2027-01-10', 15).toISOString()).toBe('2026-12-26T12:00:00.000Z');
  });

  it('programar la próxima semana deja SKIPPED los de 30 y 15 días; el de 1 día queda PENDING', () => {
    const now = new Date('2026-09-27T15:00:00Z'); // domingo 10:00 Bogotá
    const plan = planReminders('2026-10-05', [1, 30, 15], now);
    expect(plan.map((item) => [item.offsetDays, item.status])).toEqual([
      [30, 'SKIPPED'],
      [15, 'SKIPPED'],
      [1, 'PENDING'],
    ]);
  });

  it('el mismo día a las 06:59 de Bogotá el de 0 días sigue pendiente; a las 07:00 ya pasó', () => {
    expect(planReminders('2026-10-05', [0], new Date('2026-10-05T11:59:00Z'))[0]?.status).toBe('PENDING');
    expect(planReminders('2026-10-05', [0], new Date('2026-10-05T12:00:00Z'))[0]?.status).toBe('SKIPPED');
  });

  it('sin días de recordatorio no planea nada y repetidos cuentan una vez', () => {
    expect(planReminders('2026-10-05', [], new Date('2026-09-01T00:00:00Z'))).toEqual([]);
    expect(planReminders('2026-10-05', [15, 15], new Date('2026-09-01T00:00:00Z'))).toHaveLength(1);
  });
});

describe('cruce de fechas', () => {
  it('se cruzan si comparten al menos un día (inclusivo)', () => {
    expect(dateRangesOverlap({ start: '2026-10-01', end: '2026-10-05' }, { start: '2026-10-05', end: '2026-10-09' })).toBe(true);
    expect(dateRangesOverlap({ start: '2026-10-01', end: '2026-10-05' }, { start: '2026-10-06', end: '2026-10-09' })).toBe(false);
    expect(dateRangesOverlap({ start: '2026-10-10', end: '2026-10-12' }, { start: '2026-10-01', end: '2026-10-31' })).toBe(true);
  });

  it('suma y resta días calendario', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-09-27', '2026-10-27')).toBe(30);
    expect(daysBetween('2026-10-27', '2026-09-27')).toBe(-30);
  });
});

describe('semanas ISO y concentración', () => {
  it('numera semanas ISO (lunes a domingo, año del jueves)', () => {
    expect(isoWeekOf('2026-10-19')).toEqual({ key: '2026-W43', start: '2026-10-19', end: '2026-10-25' });
    expect(isoWeekOf('2027-01-01').key).toBe('2026-W53');
    expect(isoWeekOf('2026-01-01').key).toBe('2026-W01');
    expect(isoWeekOf('2024-12-30').key).toBe('2025-W01');
  });

  it('lista las semanas que tocan la ventana', () => {
    expect(isoWeeksBetween('2026-10-01', '2026-10-14').map((week) => week.key)).toEqual(['2026-W40', '2026-W41', '2026-W42']);
  });

  it('sin umbral no alerta; con umbral alerta solo las semanas que lo superan', () => {
    const items = [
      { id: 'a', start: '2026-10-19', end: '2026-10-20' },
      { id: 'b', start: '2026-10-21', end: '2026-10-23' },
      { id: 'c', start: '2026-10-25', end: '2026-10-27' },
    ];
    expect(weekConcentration(items, '2026-10-12', '2026-11-01', null)).toEqual([]);
    const loads = weekConcentration(items, '2026-10-12', '2026-11-01', 2);
    expect(loads.map((load) => [load.week.key, load.inventoryIds])).toEqual([['2026-W43', ['a', 'b', 'c']]]);
    expect(weekConcentration(items, '2026-10-12', '2026-11-01', 3)).toEqual([]);
  });
});

describe('cobertura: orden', () => {
  it('nunca revisados primero, luego más días, luego peor tasa de no encontrados, luego código', () => {
    const rows = [
      { code: 'A', daysSinceLast: 10, expected: 100, notFound: 1 },
      { code: 'B', daysSinceLast: null, expected: null, notFound: null },
      { code: 'C', daysSinceLast: 400, expected: 50, notFound: 0 },
      { code: 'D', daysSinceLast: 10, expected: 10, notFound: 5 },
      { code: 'E', daysSinceLast: null, expected: null, notFound: null },
      { code: 'F', daysSinceLast: 10, expected: 0, notFound: 0 },
    ];
    expect([...rows].sort(compareCoverage).map((row) => row.code)).toEqual(['B', 'E', 'C', 'D', 'A', 'F']);
  });
});

describe('enmascarado de correos (Ley 1581)', () => {
  it('deja la inicial y el dominio', () => {
    expect(maskEmail('juliana.perez@unac.edu.co')).toBe('j***@unac.edu.co');
    expect(maskEmail('  x@unac.edu.co ')).toBe('x***@unac.edu.co');
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('')).toBeNull();
    expect(maskEmail('sin-arroba')).toBe('***');
  });
});
