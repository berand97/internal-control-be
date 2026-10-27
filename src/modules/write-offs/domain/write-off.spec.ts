import { canWriteOffTransition, isWriteOffEditable, WRITE_OFF_STATUSES, writeOffReasonText } from './write-off.js';

describe('estados de la baja', () => {
  it('DRAFT pasa a PENDING_SIGNATURES o CANCELLED', () => {
    expect(canWriteOffTransition('DRAFT', 'PENDING_SIGNATURES')).toBe(true);
    expect(canWriteOffTransition('DRAFT', 'CANCELLED')).toBe(true);
    expect(canWriteOffTransition('DRAFT', 'COMPLETED')).toBe(false);
  });

  it('PENDING_SIGNATURES termina en COMPLETED, REJECTED o CANCELLED', () => {
    for (const to of ['COMPLETED', 'REJECTED', 'CANCELLED'] as const) {
      expect(canWriteOffTransition('PENDING_SIGNATURES', to)).toBe(true);
    }
    expect(canWriteOffTransition('PENDING_SIGNATURES', 'DRAFT')).toBe(false);
  });

  it('los estados finales no cambian', () => {
    for (const from of ['COMPLETED', 'REJECTED', 'CANCELLED'] as const) {
      for (const to of WRITE_OFF_STATUSES) {
        expect(canWriteOffTransition(from, to)).toBe(false);
      }
    }
  });

  it('solo el borrador se edita', () => {
    expect(WRITE_OFF_STATUSES.filter(isWriteOffEditable)).toEqual(['DRAFT']);
  });
});

describe('texto del motivo', () => {
  it('usa la etiqueta y agrega el detalle', () => {
    expect(writeOffReasonText('THEFT', null)).toBe('Hurto');
    expect(writeOffReasonText('THEFT', ' Denuncia 123 ')).toBe('Hurto. Denuncia 123');
  });

  it('con OTHER muestra el detalle', () => {
    expect(writeOffReasonText('OTHER', 'Cambio de normativa')).toBe('Cambio de normativa');
    expect(writeOffReasonText('OTHER', null)).toBe('Otro');
  });
});
