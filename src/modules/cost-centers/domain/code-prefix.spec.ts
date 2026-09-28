import { describe, expect, it } from 'vitest';
import {
  deriveParentCode,
  longestPrefix,
  parentCandidates,
  prefixRange,
  prefixRangeMessage,
  suggestInPrefix,
  suggestUnderParent,
} from './code-prefix.js';

// Forma de la hoja 2025: false = agrupador (Movimiento 0), true = de movimiento.
const SHEET: Record<string, boolean> = {
  '1': false,
  '1000': false,
  '1010': true,
  '1100': false,
  '1110': true,
  '3000': false,
  '3040': true,
  '3050': false,
  '3051': true,
  '9': false,
  '9200': false,
  '9205': false,
  '9206': true,
  '9211': true,
  '9220': true,
  '9221': true,
};
const lookup = (code: string): boolean | undefined => (code in SHEET ? !SHEET[code] : undefined);

describe('código de centro de costo', () => {
  it('rango y mensaje de un prefijo', () => {
    expect(prefixRange('4')).toEqual({ from: '4000', to: '4999' });
    expect(prefixRange('43')).toEqual({ from: '4300', to: '4399' });
    expect(prefixRangeMessage('Vicerrectoría Financiera', '4')).toBe(
      'Los centros de Vicerrectoría Financiera van de 4000 a 4999 (el código debe empezar por 4)',
    );
  });

  it('candidatos a padre: XYZ0 (agrupador), XY00, X000, X, sin el propio código', () => {
    expect(parentCandidates('1110').map((candidate) => candidate.code)).toEqual(['1100', '1000', '1']);
    expect(parentCandidates('1100').map((candidate) => candidate.code)).toEqual(['1000', '1']);
    expect(parentCandidates('1000').map((candidate) => candidate.code)).toEqual(['1']);
    expect(parentCandidates('3051')[0]).toEqual({ code: '3050', mustBeGrouping: true });
    expect(parentCandidates('1')).toEqual([]);
    expect(parentCandidates('100')).toEqual([]);
    expect(parentCandidates('HEAD-A')).toEqual([]);
  });

  it('padre derivado del código con los casos de la hoja 2025', () => {
    expect(deriveParentCode('1', lookup)).toBeNull();
    expect(deriveParentCode('1000', lookup)).toBe('1');
    expect(deriveParentCode('1010', lookup)).toBe('1000');
    expect(deriveParentCode('1110', lookup)).toBe('1100');
    expect(deriveParentCode('1100', lookup)).toBe('1000');
    // Subgrupo por código: 3050 es agrupador.
    expect(deriveParentCode('3051', lookup)).toBe('3050');
    // 3040 no es agrupador: su XYZ0 es él mismo; sube a 3000. No existe «3»: 3000 queda sin padre.
    expect(deriveParentCode('3040', lookup)).toBe('3000');
    expect(deriveParentCode('3000', lookup)).toBeNull();
    // 9205 es subgrupo solo por nombre: por código, 9206–9211 van a 9200 y 9205 queda sin hijos.
    expect(deriveParentCode('9206', lookup)).toBe('9200');
    expect(deriveParentCode('9211', lookup)).toBe('9200');
    expect(deriveParentCode('9205', lookup)).toBe('9200');
    // 9220 tiene movimiento: no es padre de 9221.
    expect(deriveParentCode('9221', lookup)).toBe('9200');
  });

  it('el prefijo más largo gana', () => {
    const units = [{ codePrefix: '4' }, { codePrefix: '43' }];
    expect(longestPrefix('4330', units)).toEqual({ codePrefix: '43' });
    expect(longestPrefix('4100', units)).toEqual({ codePrefix: '4' });
    expect(longestPrefix('3000', units)).toBeUndefined();
  });

  it('sugiere el siguiente XYnn libre bajo el padre', () => {
    expect(suggestUnderParent('1100', new Set(['1100', '1110', '1120']))).toEqual({
      code: '1121',
      rangeFrom: '1101',
      rangeTo: '1199',
      reason: null,
    });
    expect(suggestUnderParent('1100', new Set(['1100'])).code).toBe('1101');
    expect(suggestUnderParent('3050', new Set(['3051', '3052', '3053'])).code).toBe('3054');
    expect(suggestUnderParent('3050', new Set(['3059'])).code).toBe('3051');
    expect(suggestUnderParent('1', new Set(['1'])).code).toBe('1000');
    expect(suggestUnderParent('1', new Set(['1000'])).code).toBeNull();
  });

  it('sugiere un bloque libre en el rango de la unidad', () => {
    expect(suggestInPrefix('4', new Set(['4000', '4100', '4300']))).toMatchObject({ code: '4400', rangeFrom: '4000' });
    expect(suggestInPrefix('4', new Set()).code).toBe('4100');
    expect(suggestInPrefix('43', new Set(['4390'])).code).toBe('4310');
  });
});
