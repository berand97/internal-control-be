import { assertPayloadTables, MAX_PAYLOAD_TABLES } from './document-engine.service.js';

describe('assertPayloadTables', () => {
  it('acepta tablas de texto con nombres de identificador y la ausencia de tablas', () => {
    expect(() => assertPayloadTables(undefined)).not.toThrow();
    expect(() => assertPayloadTables({ hallazgos: [{ codigo: 'AU', cantidad: '2' }], vacia: [] })).not.toThrow();
  });

  it.each([
    ['no es objeto', []],
    ['nombre inválido', { 'mala tabla': [] }],
    ['filas que no son lista', { hallazgos: {} }],
    ['fila que no es objeto', { hallazgos: ['x'] }],
    ['columna inválida', { hallazgos: [{ 'a.b': 'x' }] }],
    ['valor que no es texto', { hallazgos: [{ cantidad: 2 }] }],
    ['demasiadas tablas', Object.fromEntries(Array.from({ length: MAX_PAYLOAD_TABLES + 1 }, (_, i) => [`t${i}`, []]))],
  ])('rechaza %s con VALIDATION_FAILED', (_label, tables) => {
    expect(() => assertPayloadTables(tables)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
