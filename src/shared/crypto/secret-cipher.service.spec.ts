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

describe('SecretCipherService: rotación de SETTINGS_ENCRYPTION_KEY (BE-12)', () => {
  const rotating = (current: string, previous: string[]) =>
    new SecretCipherService({
      getOrThrow: (key: string) => (key === 'settingsEncryptionKey' ? current : previous),
    } as never);

  it('descifra con la clave anterior y avisa que hay que volver a sellar', () => {
    const sealed = cipherFor('clave-vieja').encrypt('secreto');
    const cipher = rotating('clave-nueva', ['clave-vieja']);
    expect(cipher.decrypt(sealed)).toBe('secreto');
    expect(cipher.needsReseal(sealed)).toBe(true);
    const resealed = cipher.encrypt(cipher.decrypt(sealed));
    expect(cipher.needsReseal(resealed)).toBe(false);
    expect(cipherFor('clave-nueva').decrypt(resealed)).toBe('secreto');
  });

  it('texto en claro también necesita sellarse; vacío no', () => {
    const cipher = rotating('clave', []);
    expect(cipher.needsReseal('plano')).toBe(true);
    expect(cipher.needsReseal(null)).toBe(false);
  });

  it('sin la clave anterior el dato viejo no se puede leer', () => {
    const sealed = cipherFor('clave-vieja').encrypt('secreto');
    expect(() => rotating('clave-nueva', []).decrypt(sealed)).toThrow();
  });
});
