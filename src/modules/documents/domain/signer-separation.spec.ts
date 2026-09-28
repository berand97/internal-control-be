import type { SignerSpec } from './document-formats.js';
import { normalizeSubstitutions, resolveSigners } from './signer-separation.js';

const TRANSFER: SignerSpec[] = [
  { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
  { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
  { order: 3, role: 'CONTROL_INTERNO', label: 'Control Interno', source: 'REQUEST' },
  { order: 4, role: 'CONTABILIDAD', label: 'Contabilidad', source: 'REQUEST' },
];

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const S = '00000000-0000-4000-8000-0000000000ee';

const payload = (signers: Record<string, string>, responsible: string, signerSubstitutions?: unknown) => ({
  responsiblePersonId: responsible,
  signers,
  ...(signerSubstitutions === undefined ? {} : { signerSubstitutions }),
});

describe('resolveSigners (separación de funciones)', () => {
  it('personas distintas: cada turno con su designado y sin sustituciones', () => {
    const resolved = resolveSigners(TRANSFER, payload({ ENTREGA: A, CONTROL_INTERNO: C, CONTABILIDAD: D }, B));
    expect(resolved.map((item) => [item.spec.role, item.personId, item.substitution])).toEqual([
      ['ENTREGA', A, null],
      ['RECIBE', B, null],
      ['CONTROL_INTERNO', C, null],
      ['CONTABILIDAD', D, null],
    ]);
  });

  it('la misma persona en Recibe y Control Interno sin sustituto: DOCUMENT_SIGNER_DUPLICATED con el campo del sustituto', () => {
    expect(() => resolveSigners(TRANSFER, payload({ ENTREGA: A, CONTROL_INTERNO: B, CONTABILIDAD: D }, B))).toThrow(
      expect.objectContaining({
        code: 'DOCUMENT_SIGNER_DUPLICATED',
        details: expect.arrayContaining([
          { field: 'signers.RECIBE', message: expect.stringContaining('Control Interno (CONTROL_INTERNO)') },
          { field: 'signerSubstitutions.CONTROL_INTERNO', message: expect.stringContaining('sustituto') },
        ]),
      }),
    );
  });

  it('conflicto sin turno de Control Interno (Entrega y Recibe): no hay sustituto posible', () => {
    expect(() => resolveSigners(TRANSFER, payload({ ENTREGA: B, CONTROL_INTERNO: C, CONTABILIDAD: D }, B))).toThrow(
      expect.objectContaining({
        code: 'DOCUMENT_SIGNER_DUPLICATED',
        message: expect.stringContaining('no hay sustituto posible'),
        details: expect.arrayContaining([{ field: 'signers', message: expect.stringContaining('cambie el firmante') }]),
      }),
    );
  });

  it('con sustituto para Control Interno: el turno lo firma el sustituto y guarda a quién reemplaza y por qué', () => {
    const resolved = resolveSigners(
      TRANSFER,
      payload({ ENTREGA: A, CONTROL_INTERNO: B, CONTABILIDAD: D }, B, { CONTROL_INTERNO: { personId: S, reason: '  Recibe los activos  ' } }),
    );
    expect(resolved.find((item) => item.spec.role === 'CONTROL_INTERNO')).toMatchObject({
      personId: S,
      substitution: { replacedPersonId: B, reason: 'Recibe los activos' },
    });
  });

  it('sustituir un rol que no es de Control Interno, sin conflicto o por otro firmante se rechaza', () => {
    const base = { ENTREGA: A, CONTROL_INTERNO: B, CONTABILIDAD: D };
    const cases: Array<[string, unknown, Record<string, string>]> = [
      ['rol no sustituible', { RECIBE: { personId: S, reason: 'Motivo' } }, base],
      ['sin conflicto', { CONTROL_INTERNO: { personId: S, reason: 'Motivo' } }, { ENTREGA: A, CONTROL_INTERNO: C, CONTABILIDAD: D }],
      ['sustituto que ya firma', { CONTROL_INTERNO: { personId: D, reason: 'Motivo' } }, base],
      ['turno que el acta no tiene', { AUDITA: { personId: S, reason: 'Motivo' } }, base],
      ['motivo corto', { CONTROL_INTERNO: { personId: S, reason: 'x' } }, base],
      ['persona inválida', { CONTROL_INTERNO: { personId: 'no', reason: 'Motivo' } }, base],
    ];
    for (const [label, substitutions, signers] of cases) {
      expect(() => resolveSigners(TRANSFER, payload(signers, B, substitutions)), label).toThrow(
        expect.objectContaining({ code: 'DOCUMENT_SIGNER_SUBSTITUTE_INVALID' }),
      );
    }
  });

  it('tres firmas de la misma persona: sustituir Control Interno no basta, quedan Entrega y Recibe', () => {
    expect(() =>
      resolveSigners(
        TRANSFER,
        payload({ ENTREGA: B, CONTROL_INTERNO: B, CONTABILIDAD: D }, B, { CONTROL_INTERNO: { personId: S, reason: 'Motivo' } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'DOCUMENT_SIGNER_DUPLICATED', message: expect.stringContaining('Entrega (ENTREGA), Recibe (RECIBE)') }));
  });

  it('normalizeSubstitutions: vacío sin sustituciones; rechaza lo que no es un mapa', () => {
    expect(normalizeSubstitutions(undefined)).toEqual({});
    expect(() => normalizeSubstitutions([])).toThrow(expect.objectContaining({ code: 'DOCUMENT_SIGNER_SUBSTITUTE_INVALID' }));
    expect(() => normalizeSubstitutions({ 'mal rol': {} })).toThrow(expect.objectContaining({ code: 'DOCUMENT_SIGNER_SUBSTITUTE_INVALID' }));
  });
});
