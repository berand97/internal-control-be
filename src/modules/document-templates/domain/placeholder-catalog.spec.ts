import { describe, expect, it } from 'vitest';
import { extractPlaceholders, nestContext } from './placeholder-catalog.js';

describe('placeholder catalog', () => {
  it('extrae tokens del XML', () => {
    const xml = '<w:t>{{acta.numero}}</w:t><w:t>{{origen.codigo}}</w:t>';
    expect(extractPlaceholders(xml)).toEqual(['acta.numero', 'origen.codigo']);
  });

  it('anida contexto plano', () => {
    expect(nestContext({ 'acta.numero': 'ACT-1', 'origen.nombre': 'CI' })).toEqual({
      acta: { numero: 'ACT-1' },
      origen: { nombre: 'CI' },
    });
  });
});
