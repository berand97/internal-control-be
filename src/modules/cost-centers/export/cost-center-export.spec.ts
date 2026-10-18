import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { CostCenterTreeNodeDto } from '../dto/responses/cost-center-structure.responses.js';
import {
  bogotaDate,
  buildCostCenterExportWorkbook,
  COST_CENTER_EXPORT_HEADERS,
  COST_CENTER_EXPORT_SHEET,
  costCenterExportRows,
} from './cost-center-export.js';

const node = (overrides: Partial<CostCenterTreeNodeDto>): CostCenterTreeNodeDto => ({
  id: 'id',
  externalCode: '4300',
  name: 'Servicios Administrativos',
  isActive: true,
  hasMovement: false,
  acceptsAssets: false,
  organizationalUnit: { id: 'u-43', code: 'CC_43', name: 'Servicios Administrativos', codePrefix: '43' },
  directAssets: 0,
  heads: [],
  children: [],
  ...overrides,
});

describe('exportación de centros de costo', () => {
  const tree = [
    node({
      children: [
        node({
          id: 'c-4310',
          externalCode: '4310',
          name: 'Contabilidad',
          hasMovement: true,
          acceptsAssets: true,
          directAssets: 7,
          heads: [
            { personId: 'p-1', personName: 'Ana Gómez' },
            { personId: 'p-2', personName: 'Luis Pérez' },
          ],
        }),
        node({ id: 'c-4320', externalCode: '4320', name: 'Tesorería', hasMovement: true, isActive: false, organizationalUnit: null }),
      ],
    }),
  ];

  it('una fila por centro, cada padre antes de sus hijos, con tipo, padre, dependencia, jefes, activos y estado', () => {
    expect(costCenterExportRows(tree)).toEqual([
      {
        code: '4300',
        name: 'Servicios Administrativos',
        type: 'Agrupador',
        parent: '',
        unit: '43 · Servicios Administrativos',
        heads: '',
        directAssets: 0,
        status: 'Activo',
      },
      {
        code: '4310',
        name: 'Contabilidad',
        type: 'Con movimiento',
        parent: '4300 · Servicios Administrativos',
        unit: '43 · Servicios Administrativos',
        heads: 'Ana Gómez; Luis Pérez',
        directAssets: 7,
        status: 'Activo',
      },
      {
        code: '4320',
        name: 'Tesorería',
        type: 'Con movimiento',
        parent: '4300 · Servicios Administrativos',
        unit: '',
        heads: '',
        directAssets: 0,
        status: 'Archivado',
      },
    ]);
  });

  it('escribe la hoja con los encabezados y las filas', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildCostCenterExportWorkbook(costCenterExportRows(tree))) as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(COST_CENTER_EXPORT_SHEET);
    expect(sheet?.getRow(1).values).toEqual([undefined, ...COST_CENTER_EXPORT_HEADERS]);
    expect(sheet?.getRow(3).values).toEqual([
      undefined,
      '4310',
      'Contabilidad',
      'Con movimiento',
      '4300 · Servicios Administrativos',
      '43 · Servicios Administrativos',
      'Ana Gómez; Luis Pérez',
      7,
      'Activo',
    ]);
    expect(sheet?.rowCount).toBe(4);
  });

  it('la fecha del archivo es la de Bogotá', () => {
    expect(bogotaDate(new Date('2026-10-19T03:00:00Z'))).toBe('2026-10-18');
  });
});
