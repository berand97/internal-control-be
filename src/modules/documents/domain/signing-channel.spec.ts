import { describe, expect, it } from 'vitest';
import { channelFor, lastFourDigits, maskName, type SignerCandidate } from './signing-channel.js';

const person = (overrides: Partial<SignerCandidate> = {}): SignerCandidate => ({
  personId: 'p1',
  personActive: true,
  email: 'ana@unac.edu.co',
  documentNumber: '1.000.123.456',
  userStatus: null,
  mfaEnabled: false,
  ...overrides,
});

describe('channelFor: los tres caminos de firma', () => {
  it('Control Interno exige usuario activo con MFA, sin excepción', () => {
    for (const role of ['AUDITA', 'CONTROL_INTERNO']) {
      expect(channelFor(role, person({ userStatus: 'ACTIVE', mfaEnabled: true }))).toEqual({ channel: 'SESSION_MFA', blockedBy: null });
      expect(channelFor(role, person({ userStatus: 'ACTIVE' })).blockedBy).toBe('SIGNATURE_MFA_REQUIRED');
      expect(channelFor(role, person()).blockedBy).toBe('SIGNATURE_NO_CHANNEL');
      expect(channelFor(role, person({ userStatus: 'SUSPENDED', mfaEnabled: true })).blockedBy).toBe('SIGNATURE_NO_CHANNEL');
    }
  });

  it('otros turnos: sesión si hay usuario activo; si no, enlace con correo y documento', () => {
    expect(channelFor('RECIBE', person({ userStatus: 'ACTIVE' }))).toEqual({ channel: 'SESSION', blockedBy: null });
    expect(channelFor('RECIBE', person())).toEqual({ channel: 'EMAIL_LINK', blockedBy: null });
    expect(channelFor('RECIBE', person({ email: null })).blockedBy).toBe('SIGNATURE_NO_CHANNEL');
    expect(channelFor('RECIBE', person({ email: '  ' })).blockedBy).toBe('SIGNATURE_NO_CHANNEL');
    expect(channelFor('RECIBE', person({ documentNumber: null })).blockedBy).toBe('SIGNATURE_NO_IDENTITY_CHECK');
    expect(channelFor('RECIBE', person({ documentNumber: 'AB1' })).blockedBy).toBe('SIGNATURE_NO_IDENTITY_CHECK');
    expect(channelFor('RECIBE', person({ personActive: false })).blockedBy).toBe('SIGNATURE_SIGNER_INACTIVE');
    expect(channelFor('RECIBE', null).blockedBy).toBe('SIGNATURE_SIGNER_UNASSIGNED');
  });

  it('últimos 4 dígitos ignoran puntos y letras; nombre enmascarado', () => {
    expect(lastFourDigits('1.000.123.456')).toBe('3456');
    expect(lastFourDigits('PA-98 76')).toBe('9876');
    expect(lastFourDigits('123')).toBeNull();
    expect(maskName('Laura Responsable Pérez')).toBe('Laura R. P.');
    expect(maskName('  ')).toBeNull();
  });
});
