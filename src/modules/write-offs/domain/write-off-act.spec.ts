import { bookValueText, buildWriteOffActContent } from './write-off-act.js';

const money = (value: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

describe('contenido del acta de baja', () => {
  const content = buildWriteOffActContent({
    reason: 'IRREPARABLE_DAMAGE',
    reasonDetail: null,
    technicalConcept: ' Tarjeta quemada ',
    finalDisposition: 'Reciclaje',
    observations: null,
    valuationDate: '2026-10-27',
    assets: [
      { id: 'a', serialNumber: 'SN-1', acquisitionDate: '2019-01-01', acquisitionPrice: 1000, depreciatedValue: 400 },
      { id: 'b', serialNumber: null, acquisitionDate: null, acquisitionPrice: 500, depreciatedValue: null },
    ],
  });

  it('arma los datos de la baja', () => {
    expect(content.fields).toMatchObject({
      motivo: 'Daño irreparable',
      motivoCodigo: 'IRREPARABLE_DAMAGE',
      conceptoTecnico: 'Tarjeta quemada',
      disposicionFinal: 'Reciclaje',
      observaciones: 'Sin observaciones',
      fechaValor: '2026-10-27',
      totalCosto: money(1500),
      totalValorLibros: money(900),
      activosSinDepreciacion: '1',
    });
  });

  it('usa la depreciación como valor en libros y si falta muestra el costo marcado', () => {
    expect(content.assetFields['a']).toEqual({ serial: 'SN-1', fechaAdquisicion: '2019-01-01', costo: money(1000), valorLibros: money(400) });
    expect(content.assetFields['b']).toEqual({ serial: '', fechaAdquisicion: '', costo: money(500), valorLibros: `${money(500)} sin depreciación` });
  });

  it('sin costo ni depreciación dice Sin dato', () => {
    expect(bookValueText({ acquisitionPrice: null, depreciatedValue: null })).toBe('Sin dato');
  });
});
