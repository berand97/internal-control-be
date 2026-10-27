import { canWriteOffTransition, isWriteOffEditable, WRITE_OFF_STATUSES, writeOffItemReason } from './write-off.js';

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

describe('motivo que queda en el activo', () => {
  it('usa el estado del acta y agrega las observaciones', () => {
    expect(writeOffItemReason('DAMAGED', null)).toBe('Dañado');
    expect(writeOffItemReason('OBSOLETE', ' Acuerdo 030-2026 ')).toBe('Obsoleto. Acuerdo 030-2026');
    expect(writeOffItemReason('NOT_AN_ASSET', '')).toBe('No es activo');
  });
});
