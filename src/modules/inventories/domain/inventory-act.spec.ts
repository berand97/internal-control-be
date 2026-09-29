import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { VerificationResult } from '../enums/verification-result.js';
import {
  type ActInput,
  type ActItem,
  buildInventoryActContent,
  FINDINGS_PERCENT_BASE,
  formatMoney,
  NO_DATA,
} from './inventory-act.js';
import { valuationOf } from './inventory-valuation.js';

const item = (id: string, overrides: Partial<ActItem> = {}): ActItem => ({
  id,
  assetId: id,
  result: VerificationResult.Found,
  actualCondition: PhysicalCondition.Good,
  expectedCodeTemporary: false,
  findingCategoryCode: null,
  missingCauseId: null,
  missingCauseOther: null,
  notes: null,
  voided: false,
  actualLocationName: null,
  resolvedAssetId: null,
  resolvedAssetCode: null,
  surplusResolution: null,
  surplusResolutionReason: null,
  ...overrides,
});

const input = (items: ActItem[], valuations: ActInput['valuations']): ActInput => ({
  code: 'TF-2026-001',
  name: 'Toma',
  scopeLabel: 'Centro de costo 10 — Sistemas',
  plannedStartDate: '2026-03-01',
  plannedEndDate: '2026-03-03',
  actualStartDate: '2026-03-01',
  actualEndDate: '2026-03-02',
  approvedAt: new Date('2026-03-04T15:00:00Z'),
  basis: {
    kind: 'SYSTEM_SNAPSHOT',
    cutId: null,
    cutDate: null,
    sourceLabel: null,
    snapshotAt: null,
    snapshotDate: '2026-03-01',
    valuationDate: '2026-03-01',
  },
  items,
  categories: [
    { code: 'AU', label: 'En uso' },
    { code: 'ANE', label: 'No encontrado' },
  ],
  causeLabels: new Map(),
  valuations,
  conditionLabels: { GOOD: 'Bueno' },
});

describe('buildInventoryActContent', () => {
  it('tabla de hallazgos por categoría con total; porcentaje sobre el precio de compra; un valor faltante es "Sin dato", nunca 0', () => {
    const content = buildInventoryActContent(
      input(
        [
          item('a', { findingCategoryCode: 'AU' }),
          item('b', { findingCategoryCode: 'AU' }),
          item('c', { findingCategoryCode: 'ANE', result: VerificationResult.Missing, missingCauseOther: 'Se desconoce' }),
          item('d', { voided: true, findingCategoryCode: 'AU' }),
        ],
        new Map([
          ['a', valuationOf(1000, null, 800)],
          ['b', valuationOf(0, 300, null)],
          ['c', valuationOf(200, null, null)],
        ]),
      ),
    );
    expect(content.tables['hallazgos']).toEqual([
      { codigo: 'AU', nombre: 'En uso', cantidad: '2', valorCompra: formatMoney(1000), porcentaje: '83,33 %', valorLibros: formatMoney(1100), esTotal: '' },
      { codigo: 'ANE', nombre: 'No encontrado', cantidad: '1', valorCompra: formatMoney(200), porcentaje: '16,67 %', valorLibros: NO_DATA, esTotal: '' },
      { codigo: 'TOTAL', nombre: 'Total', cantidad: '3', valorCompra: formatMoney(1200), porcentaje: '100,00 %', valorLibros: NO_DATA, esTotal: 'Sí' },
    ]);
    expect(content.assetIds).toEqual(['a', 'b', 'c']);
    expect(content.assetFields['c']).toMatchObject({ resultado: 'No encontrado', causa: 'Se desconoce', valorLibros: NO_DATA });
    expect(content.fields).toMatchObject({
      corteContable: 'Sin corte contable: estado del sistema al 1 de marzo de 2026',
      totalEsperados: '3',
      totalFaltantes: '1',
      totalSinCategoria: '0',
    });
  });

  it('el porcentaje es "Sin dato" si falta el precio de compra de algún bien o el total es 0; dice su base', () => {
    const missing = buildInventoryActContent(
      input(
        [item('a', { findingCategoryCode: 'AU' }), item('b', { findingCategoryCode: 'ANE' })],
        new Map([
          ['a', valuationOf(1000, 900, null)],
          ['b', valuationOf(null, 100, null)],
        ]),
      ),
    );
    expect(missing.tables['hallazgos']?.map((row) => [row['codigo'], row['valorCompra'], row['porcentaje']])).toEqual([
      ['AU', formatMoney(1000), NO_DATA],
      ['ANE', NO_DATA, NO_DATA],
      ['TOTAL', NO_DATA, NO_DATA],
    ]);
    expect(missing.fields['basePorcentaje']).toBe(FINDINGS_PERCENT_BASE);
    const zero = buildInventoryActContent(
      input([item('a', { findingCategoryCode: 'AU' })], new Map([['a', valuationOf(0, null, null)]])),
    );
    expect(zero.tables['hallazgos']?.map((row) => row['porcentaje'])).toEqual([NO_DATA, NO_DATA, NO_DATA]);
    // Sin bienes con categoría el total es 0: tampoco hay porcentaje que afirmar.
    const empty = buildInventoryActContent(input([], new Map()));
    expect(empty.tables['hallazgos']?.map((row) => row['porcentaje'])).toEqual([NO_DATA, NO_DATA, NO_DATA]);
  });

  it('quién atendió por el área es informativo: nombre o "Sin dato"', () => {
    expect(buildInventoryActContent({ ...input([], new Map()), attendedBy: 'Asistente Pérez' }).fields['atendioPorArea']).toBe('Asistente Pérez');
    expect(buildInventoryActContent(input([], new Map())).fields['atendioPorArea']).toBe(NO_DATA);
  });

  it('los sobrantes sin activo van a su tabla; el resuelto entra como activo', () => {
    const content = buildInventoryActContent(
      input(
        [
          item('s1', { assetId: null, result: VerificationResult.Surplus, notes: 'Mesa', actualLocationName: 'Of. 204' }),
          item('s2', {
            assetId: null,
            result: VerificationResult.Surplus,
            notes: 'Silla',
            resolvedAssetId: 'new',
            resolvedAssetCode: 'A2026-0009',
            surplusResolution: 'CREATE_ASSET',
          }),
        ],
        new Map([['new', valuationOf(50, null, null)]]),
      ),
    );
    expect(content.tables['sobrantes']).toEqual([
      expect.objectContaining({ indice: '1', descripcion: 'Mesa', ubicacion: 'Of. 204', resolucion: 'Sin decisión' }),
      expect.objectContaining({ indice: '2', descripcion: 'Silla', resolucion: 'Registrado como activo', activoCreado: 'A2026-0009' }),
    ]);
    expect(content.assetIds).toEqual(['new']);
    expect(content.assetFields['new']).toMatchObject({ resultado: 'Sobrante', sobranteResuelto: 'Sí', valorCompra: formatMoney(50) });
  });
});
