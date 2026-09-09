import { describe, expect, it } from 'vitest';
import { extractSmtpAddress } from './smtp-client.js';

describe('extractSmtpAddress', () => {
  it('toma el correo entre ángulos', () => {
    expect(extractSmtpAddress('Control Interno <noreply@unac.edu.co>')).toBe(
      'noreply@unac.edu.co',
    );
  });

  it('deja el valor si ya es un correo', () => {
    expect(extractSmtpAddress('noreply@unac.edu.co')).toBe('noreply@unac.edu.co');
  });
});
