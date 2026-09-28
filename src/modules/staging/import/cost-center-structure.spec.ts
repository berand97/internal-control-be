import { describe, expect, it } from 'vitest';
import { type DbCenter, type FileCenter, planCostCenterStructure } from './cost-center-structure.js';

const row = (rowNumber: number, code: string, hasMovement: boolean, name = `Centro ${code}`): FileCenter => ({
  rowNumber,
  code,
  name,
  hasMovement,
  unitCode: null,
});

const existing = (code: string, extra: Partial<DbCenter> = {}): DbCenter => ({
  id: `id-${code}`,
  code,
  name: `Centro ${code}`,
  parentId: null,
  unitId: null,
  hasMovement: true,
  isActive: true,
  activeAssets: 0,
  ...extra,
});

// Forma de la hoja 2025: raíces de un dígito, sin «3», subgrupo 3050 por código y 9205 solo por nombre.
const FILE: FileCenter[] = [
  row(5, '1', false, 'RECTORÍA'),
  row(6, '1000', false),
  row(7, '1010', true),
  row(8, '3000', false),
  row(9, '3040', true),
  row(10, '3050', false),
  row(11, '3051', true),
  row(12, '4', false, 'VICERRECTORÍA FINANCIERA'),
  row(13, '4300', false),
  row(14, '4330', true, 'TALENTO HUMANO'),
  row(15, '9', false, 'INSTITUCIONAL'),
  row(16, '9200', false),
  row(17, '9205', false),
  row(18, '9206', true),
];

describe('plan de estructura de centros de costo', () => {
  it('deriva padres, crea unidades por prefijo y avisa el prefijo 3 y el 9205', () => {
    const plan = planCostCenterStructure(FILE, [existing('4330', { name: 'Talento Humano', activeAssets: 7 })], []);
    const byCode = new Map(plan.centers.map((center) => [center.code, center]));
    expect(byCode.get('1')?.parentCode).toBeNull();
    expect(byCode.get('1000')?.parentCode).toBe('1');
    expect(byCode.get('1010')?.parentCode).toBe('1000');
    expect(byCode.get('3051')?.parentCode).toBe('3050');
    expect(byCode.get('3040')?.parentCode).toBe('3000');
    expect(byCode.get('3000')?.parentCode).toBeNull();
    expect(byCode.get('9206')?.parentCode).toBe('9200');
    expect(byCode.get('9205')?.parentCode).toBe('9200');
    expect(byCode.get('4330')?.parentCode).toBe('4300');

    expect(plan.units.map((unit) => [unit.prefix, unit.action, unit.code, unit.name])).toEqual([
      ['1', 'CREATE', 'CC_1', 'RECTORÍA'],
      ['4', 'CREATE', 'CC_4', 'VICERRECTORÍA FINANCIERA'],
      ['9', 'CREATE', 'CC_9', 'INSTITUCIONAL'],
    ]);
    expect(byCode.get('4330')?.unit).toEqual({ prefix: '4' });
    expect(byCode.get('4')?.unit).toEqual({ prefix: '4' });
    expect(byCode.get('3051')?.unit).toBeNull();

    expect(plan.counts).toMatchObject({
      toInsert: 13,
      existingInFile: 1,
      parentChanges: 1,
      unitChanges: 1,
      movementChanges: 0,
      nameDifferences: 1,
      orphans: 1,
      unitsToCreate: 3,
      groupingWithoutChildren: 1,
      prefixesWithoutUnit: ['3'],
      notInFile: 0,
    });
    const codes = plan.issues.map((issue) => `${issue.code}:${issue.rawValue ?? ''}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'NAME_DIFFERS:4330',
        'PARENT_NOT_FOUND:3000',
        'GROUPING_WITHOUT_CHILDREN:9205',
        'PREFIX_WITHOUT_UNIT:3',
        'UNIT_CREATED:4',
      ]),
    );
  });

  it('un existente con activos no pasa a agrupador; un código de un dígito siempre es agrupador', () => {
    const plan = planCostCenterStructure(
      [row(1, '4', true), row(2, '4000', false)],
      [existing('4000', { activeAssets: 3 })],
      [],
    );
    const byCode = new Map(plan.centers.map((center) => [center.code, center]));
    expect(byCode.get('4')?.hasMovement).toBe(false);
    expect(byCode.get('4000')).toMatchObject({ hasMovement: true, movementChanges: false });
    expect(plan.counts.groupingWithAssets).toBe(1);
    expect(plan.issues.some((issue) => issue.code === 'GROUPING_HAS_ASSETS' && issue.rawValue === '4000')).toBe(true);
  });

  it('asocia una unidad existente con ese prefijo y no borra la unidad ni el padre que no puede derivar', () => {
    const plan = planCostCenterStructure(
      [row(1, '5', false), row(2, '5100', true), row(3, '3010', true)],
      [existing('3010', { unitId: 'u-manual', parentId: 'id-X' }), existing('X')],
      [{ id: 'u-5', code: 'VBU', name: 'Bienestar', codePrefix: '5', isActive: true }],
    );
    const byCode = new Map(plan.centers.map((center) => [center.code, center]));
    expect(plan.units).toEqual([
      { prefix: '5', rowNumber: 1, name: 'Bienestar', action: 'EXISTING', unitId: 'u-5', code: 'VBU' },
    ]);
    expect(byCode.get('5100')?.unit).toEqual({ id: 'u-5' });
    expect(byCode.get('3010')).toMatchObject({ unit: { id: 'u-manual' }, unitChanges: false, parentCode: 'X', parentChanges: false });
    expect(plan.counts.notInFile).toBe(1);
  });
});
