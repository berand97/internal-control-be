import { describe, expect, it } from 'vitest';
import { SecretCipherService } from './secret-cipher.service.js';

const cipherFor = (key: string): SecretCipherService =>
  new SecretCipherService({
    getOrThrow: () => key,
  } as never);

describe('SecretCipherService', () => {
  it('cifra y descifra un secreto', () => {
    const cipher = cipherFor('clave-unitaria');
    const sealed = cipher.encrypt('AppPassword.1234');
    expect(sealed).toMatch(/^enc\.v1\./);
    expect(sealed).not.toContain('AppPassword.1234');
    expect(cipher.decrypt(sealed)).toBe('AppPassword.1234');
  });

  it('deja pasar texto legado sin prefijo para poder sellarlo después', () => {
    const cipher = cipherFor('clave-unitaria');
    expect(cipher.decrypt('smtp.office365.com')).toBe('smtp.office365.com');
    expect(cipher.isEncrypted('smtp.office365.com')).toBe(false);
  });

  it('no vuelve a cifrar un valor ya sellado', () => {
    const cipher = cipherFor('clave-unitaria');
    const sealed = cipher.encrypt('dato');
    expect(cipher.encrypt(sealed)).toBe(sealed);
  });

  it('guarda null si el valor viene vacío', () => {
    const cipher = cipherFor('clave-unitaria');
    expect(cipher.encrypt('')).toBeNull();
    expect(cipher.encrypt(null)).toBeNull();
    expect(cipher.decrypt(null)).toBeNull();
  });

  it('falla si la clave no coincide', () => {
    const sealed = cipherFor('clave-a').encrypt('secreto');
    expect(() => cipherFor('clave-b').decrypt(sealed)).toThrow();
  });
});
