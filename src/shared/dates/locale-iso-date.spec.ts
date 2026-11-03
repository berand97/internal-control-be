import { describe, expect, it } from 'vitest';

import { localeIsoDate } from './locale-iso-date.js';

describe('localeIsoDate', () => {
  it('usa el día de Bogotá, no el UTC', () => {
    expect(localeIsoDate(new Date('2026-09-26T03:00:00Z'))).toBe('2026-09-25');
    expect(localeIsoDate(new Date('2026-09-26T05:00:00Z'))).toBe('2026-09-26');
  });
});
