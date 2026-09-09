import { describe, expect, it } from 'vitest';
import {
  EMAIL_PLACEHOLDER_CATALOG,
  extractEmailPlaceholders,
  renderEmailText,
} from './email-template-catalog.js';

describe('email-template-catalog', () => {
  it('extrae tokens únicos', () => {
    expect(
      extractEmailPlaceholders('Hola {{user.username}} en {{app.name}} y {{user.username}}'),
    ).toEqual(['user.username', 'app.name']);
  });

  it('sustituye tokens y deja vacío lo que falte', () => {
    expect(renderEmailText('Hola {{user.username}} {{faltante}}', { 'user.username': 'ana' })).toBe(
      'Hola ana ',
    );
  });

  it('exige tokens de invitación y reset', () => {
    expect(EMAIL_PLACEHOLDER_CATALOG.USER_INVITATION.required).toContain(
      'auth.temporaryPassword',
    );
    expect(EMAIL_PLACEHOLDER_CATALOG.PASSWORD_RESET.required).toContain('auth.resetUrl');
  });
});
