import {
  checkUnitPrefix,
  childPrefixError,
  expectedParentCode,
  resolveCenterParent,
  resolveCenterUnit,
  suggestForUnitPrefix,
  suggestUnderGroupCenter,
  suggestUnitPrefix,
} from './org-chart-rules.js';

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

describe('sugerencias del organigrama', () => {
  it('bajo 4350: 4351, 4352… sin 4355', () => {
    expect(suggestUnderGroupCenter('4350', new Set(['4351', '4352']))).toMatchObject({ fixedPrefix: '435', code: '4353' });
    expect(suggestUnderGroupCenter('4350', new Set(['4351', '4352', '4353', '4354']))?.code).toBe('4356');
    expect(suggestUnderGroupCenter('4300', new Set())).toBeNull();
    expect(suggestUnderGroupCenter('4351', new Set())).toBeNull();
  });
  it('en la unidad 43: el siguiente 43Z0 libre; en la 4: 40Z0', () => {
    expect(suggestForUnitPrefix('43', new Set(['4310', '4320', '4330']))).toMatchObject({ fixedPrefix: '43', code: '4340' });
    expect(suggestForUnitPrefix('4', new Set(['4010']))).toMatchObject({ fixedPrefix: '4', code: '4020' });
  });
  it('prefijo de unidad: el siguiente libre bajo el del ancestro', () => {
    expect(suggestUnitPrefix('4', new Set(['41', '43', '7']))).toEqual({ fixedPrefix: '4', suggested: '42', taken: ['41', '43'] });
    expect(suggestUnitPrefix(null, new Set(['1', '2']))).toMatchObject({ fixedPrefix: '', suggested: '3' });
  });
});

describe('excepción del prefijo jerárquico', () => {
  it('30 bajo la Académica (2) sin unidad 3: se acepta con advertencia', () => {
    expect(checkUnitPrefix('30', '2', new Set(['1', '2', '4', '5', '9']))).toMatchObject({ level: 'WARNING' });
  });
  it('53 bajo 4 con la unidad 5: error', () => {
    expect(checkUnitPrefix('53', '4', new Set(['4', '5']))).toMatchObject({
      level: 'ERROR',
      message: expect.stringContaining('los códigos que empiezan por 5 son de otra unidad'),
    });
  });
  it('431 bajo 4 con la unidad 43: error; 43 bajo 4: bien', () => {
    expect(checkUnitPrefix('431', '4', new Set(['4', '43'])).level).toBe('ERROR');
    expect(checkUnitPrefix('43', '4', new Set(['4'])).level).toBe('OK');
  });
});
