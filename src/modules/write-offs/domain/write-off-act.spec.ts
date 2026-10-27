import { buildWriteOffActContent, totalsOf } from './write-off-act.js';

const money = (value: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

describe('contenido del acta de baja', () => {
  const content = buildWriteOffActContent({
    authorizedTotal: 4000,
    observations: ' La depreciación cambió ',
    councilAgreementNumber: 'ACUERDO 030-2026',
    councilAgreementDate: '2026-07-28',
    vicefinanceReports: 'IBV - 00015 y 00016',
    items: [
      {
        assetId: 'a',
        quantity: 1,
        state: 'OBSOLETE',
        notes: 'Autorizado por el Consejo',
        costCenter: '4410 SISTEMAS',
        acquisitionDocument: 'IC-740',
        acquisitionDate: '2016-01-31',
        acquisitionPrice: 4169000.1,
      },
      {
        assetId: 'b',
        quantity: 10,
        state: 'DAMAGED',
        notes: null,
        costCenter: '5310 EGRESADOS',
        acquisitionDocument: null,
        acquisitionDate: null,
        acquisitionPrice: null,
      },
    ],
  });

  it('arma los totales y el pie del acta', () => {
    expect(content.fields).toEqual({
      totalInforme: money(4169000.1),
      totalAutorizado: money(4000),
      diferencia: money(4000 - 4169000.1),
      nota: 'La depreciación cambió',
      acuerdoConsejo: 'ACUERDO 030-2026',
      fechaAcuerdo: '28 DE JULIO DE 2026',
      informesVicefinanciera: 'IBV - 00015 y 00016',
    });
  });

  it('llena cada fila con las columnas del formato oficial', () => {
    expect(content.assetFields['a']).toEqual({
      cantidad: '1',
      documento: 'IC-740',
      centro: '4410 SISTEMAS',
      fechaCompra: '2016-01-31',
      precioCompra: money(4169000.1),
      estado: 'Obsoleto',
      observaciones: 'Autorizado por el Consejo',
    });
    expect(content.assetFields['b']).toMatchObject({ cantidad: '10', documento: '', centro: '5310 EGRESADOS', precioCompra: 'Sin dato', estado: 'Dañado' });
  });

  it('la diferencia es autorizado menos informe, sin errores de redondeo', () => {
    expect(totalsOf([0.1, 0.2], 0.3)).toEqual({ report: 0.3, authorized: 0.3, difference: 0 });
    expect(totalsOf([100, null], null)).toEqual({ report: 100, authorized: null, difference: null });
  });
});
