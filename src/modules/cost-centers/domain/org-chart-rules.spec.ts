import { childPrefixError, expectedParentCode, resolveCenterParent, resolveCenterUnit } from './org-chart-rules.js';

const existing = new Set(['4110', '4115', '4120', '4350', '4351', '4352', '2510', '2520', '2521', '3051', '3052', '3053', '9206']);
const exists = (code: string) => existing.has(code);

describe('padre de un centro (organigrama)', () => {
  it.each([
    ['4351', '4350'],
    ['4352', '4350'],
    ['2521', '2520'],
    ['2511', '2510'],
  ])('%s cuelga de %s', (code, parent) => {
    expect(resolveCenterParent(code, exists)).toEqual({ parentCode: parent, missingParentCode: null });
  });

  it('4115 es hermano de 4110 (de 5 en 5): sin centro padre', () => {
    expect(resolveCenterParent('4115', exists)).toEqual({ parentCode: null, missingParentCode: null });
    expect(expectedParentCode('2525')).toBeNull();
  });

  it('XYZ0 no tiene centro padre: cuelga de su unidad', () => {
    expect(resolveCenterParent('4350', exists)).toEqual({ parentCode: null, missingParentCode: null });
    expect(resolveCenterParent('4110', exists)).toEqual({ parentCode: null, missingParentCode: null });
  });

  it('3051 sin 3050: sin padre y se reporta el que falta (nunca se rechaza)', () => {
    expect(resolveCenterParent('3051', exists)).toEqual({ parentCode: null, missingParentCode: '3050' });
    expect(resolveCenterParent('9207', exists)).toEqual({ parentCode: null, missingParentCode: '9200' });
  });

  it('códigos que no son de cuatro dígitos no piden padre', () => {
    expect(expectedParentCode('4')).toBeNull();
    expect(expectedParentCode('43A1')).toBeNull();
    expect(expectedParentCode('43511')).toBeNull();
  });
});

describe('unidad de un centro (prefijo más largo)', () => {
  const units = [
    { id: 'u4', codePrefix: '4' },
    { id: 'u43', codePrefix: '43' },
    { id: 'u2', codePrefix: '2' },
    { id: 'u25', codePrefix: '25' },
    { id: 'u9', codePrefix: '9' },
  ];
  it.each([
    ['2523', 'u25'],
    ['4351', 'u43'],
    ['4120', 'u4'],
    ['9228', 'u9'],
  ])('%s → %s', (code, unit) => {
    expect(resolveCenterUnit(code, units)?.id).toBe(unit);
  });
  it('sin unidad que cuadre: undefined', () => {
    expect(resolveCenterUnit('7001', units)).toBeUndefined();
  });
});

describe('prefijo jerárquico de unidades', () => {
  it('hija de 4: 41–49', () => {
    expect(childPrefixError('43', '4')).toBeNull();
    expect(childPrefixError('431', '43')).toBeNull();
  });
  it('sin ancestro con prefijo, cualquiera vale', () => {
    expect(childPrefixError('4', null)).toBeNull();
    expect(childPrefixError('43', null)).toBeNull();
  });
  it('rechaza otro dígito inicial, el mismo largo o dos dígitos de más', () => {
    expect(childPrefixError('53', '4')).toContain('debe ser 4 seguido de un dígito (40–49)');
    expect(childPrefixError('4', '4')).not.toBeNull();
    expect(childPrefixError('431', '4')).not.toBeNull();
  });
});
