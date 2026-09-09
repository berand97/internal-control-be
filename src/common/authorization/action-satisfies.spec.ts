import { describe, expect, it } from 'vitest';
import { actionSatisfies } from './action-satisfies.js';

describe('actionSatisfies', () => {
  it('acepta la acción exacta', () => {
    expect(actionSatisfies(new Set(['manage']), 'manage')).toBe(true);
    expect(actionSatisfies(new Set(['update']), 'update')).toBe(true);
  });

  it('un permiso de escritura desbloquea un menú que pide read', () => {
    expect(actionSatisfies(new Set(['manage']), 'read')).toBe(true);
    expect(actionSatisfies(new Set(['create']), 'read')).toBe(true);
  });

  it('no inventa acciones: manage no satisface update', () => {
    expect(actionSatisfies(new Set(['manage']), 'update')).toBe(false);
    expect(actionSatisfies(new Set(['read']), 'manage')).toBe(false);
  });

  it('sin permisos no abre el menú', () => {
    expect(actionSatisfies(new Set(), 'read')).toBe(false);
  });
});
