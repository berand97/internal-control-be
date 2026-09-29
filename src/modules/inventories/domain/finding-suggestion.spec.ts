import { describe, expect, it } from 'vitest';
import { type SuggestibleCategory, suggestFindingCategory } from './finding-suggestion.js';

const category = (overrides: Partial<SuggestibleCategory> & { code: string }): SuggestibleCategory => ({
  isActive: true,
  sortOrder: 0,
  suggestResults: null,
  suggestConditions: null,
  ...overrides,
});

// La siembra de la migración 1767225870000, solo como datos.
const seeded: ReadonlyArray<SuggestibleCategory> = [
  category({ code: 'AU', sortOrder: 10, suggestResults: ['FOUND', 'MISPLACED'] }),
  category({ code: 'ANE', sortOrder: 20, suggestResults: ['MISSING'] }),
  category({ code: 'AOD', sortOrder: 30, suggestConditions: ['OBSOLETE', 'POOR'] }),
];

describe('suggestFindingCategory', () => {
  it('sugiere por resultado cuando la condición observada no pesa', () => {
    expect(suggestFindingCategory(seeded, { result: 'FOUND', actualCondition: 'GOOD' })).toBe('AU');
    expect(suggestFindingCategory(seeded, { result: 'MISPLACED', actualCondition: 'NEW' })).toBe('AU');
    expect(suggestFindingCategory(seeded, { result: 'MISSING', actualCondition: null })).toBe('ANE');
  });

  it('la condición observada gana sobre el resultado', () => {
    expect(suggestFindingCategory(seeded, { result: 'FOUND', actualCondition: 'OBSOLETE' })).toBe('AOD');
    expect(suggestFindingCategory(seeded, { result: 'MISPLACED', actualCondition: 'POOR' })).toBe('AOD');
    expect(suggestFindingCategory(seeded, { result: 'SURPLUS', actualCondition: 'POOR' })).toBe('AOD');
  });

  it('no sugiere nada para pendientes, no verificados o sin coincidencias', () => {
    expect(suggestFindingCategory(seeded, { result: 'PENDING', actualCondition: null })).toBeNull();
    expect(suggestFindingCategory(seeded, { result: 'NOT_VERIFIED', actualCondition: null })).toBeNull();
    expect(suggestFindingCategory(seeded, { result: 'SURPLUS', actualCondition: 'GOOD' })).toBeNull();
  });

  it('ignora inactivas y categorías sin criterios', () => {
    const categories = [
      category({ code: 'X', suggestResults: ['FOUND'], isActive: false }),
      category({ code: 'Z' }),
    ];
    expect(suggestFindingCategory(categories, { result: 'FOUND', actualCondition: 'GOOD' })).toBeNull();
  });

  it('partir AOD en dos filas no exige código nuevo', () => {
    const split = [
      ...seeded.filter((item) => item.code !== 'AOD'),
      category({ code: 'AO', sortOrder: 30, suggestConditions: ['OBSOLETE'] }),
      category({ code: 'AD', sortOrder: 31, suggestConditions: ['POOR'] }),
    ];
    expect(suggestFindingCategory(split, { result: 'FOUND', actualCondition: 'OBSOLETE' })).toBe('AO');
    expect(suggestFindingCategory(split, { result: 'FOUND', actualCondition: 'POOR' })).toBe('AD');
  });

  it('con dos criterios exige ambos y desempata por orden', () => {
    const categories = [
      category({ code: 'B', sortOrder: 2, suggestResults: ['FOUND'] }),
      category({ code: 'A', sortOrder: 1, suggestResults: ['FOUND'] }),
      category({ code: 'C', sortOrder: 9, suggestResults: ['MISSING'], suggestConditions: ['POOR'] }),
    ];
    expect(suggestFindingCategory(categories, { result: 'FOUND', actualCondition: 'POOR' })).toBe('A');
  });
});
