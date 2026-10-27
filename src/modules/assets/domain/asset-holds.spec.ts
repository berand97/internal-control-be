import { HOLD_OPEN_HANDOVER, HOLD_OPEN_WRITE_OFF, holdReasons } from './asset-holds.js';

describe('retenciones de activos por baja y entrega', () => {
  it('la baja abierta bloquea con su motivo', () => {
    expect(HOLD_OPEN_WRITE_OFF()).toContain('asset_write_off_item wi WHERE wi.asset_id = a.id AND wi.open');
    expect(HOLD_OPEN_WRITE_OFF()).toContain("'está en una baja abierta'");
  });

  it('puede excluir la baja propia', () => {
    const sql = HOLD_OPEN_WRITE_OFF('$3');
    expect(sql).toContain('wi.write_off_id IS DISTINCT FROM $3::uuid');
    expect(sql).toContain("'está en otra baja abierta'");
  });

  it('la entrega abierta bloquea', () => {
    expect(HOLD_OPEN_HANDOVER).toContain('asset_handover_item hi WHERE hi.asset_id = a.id AND hi.open');
  });

  it('holdReasons junta las retenciones sin nulos', () => {
    expect(holdReasons(HOLD_OPEN_WRITE_OFF(), HOLD_OPEN_HANDOVER)).toMatch(/^ARRAY_REMOVE\(ARRAY\[[\s\S]*\]::text\[\], NULL\)$/);
  });
});
