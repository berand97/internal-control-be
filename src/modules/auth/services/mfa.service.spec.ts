import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { SecretCipherService } from '../../../shared/crypto/secret-cipher.service.js';
import { MfaService } from './mfa.service.js';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC_BASE64 = 'iVBORw0KGgo';

const cipherWithKey = (key: string): SecretCipherService =>
  new SecretCipherService({ getOrThrow: () => key } as never);

describe('MfaService', () => {
  const service = new MfaService(cipherWithKey('clave-de-prueba'));

  describe('createEnrollment', () => {
    it('genera secreto, otpauthUrl y QR PNG local a partir de la URI', async () => {
      const enrollment = await service.createEnrollment(
        'admin@unac.edu.co',
        'UNAC',
      );

      expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);
      expect(enrollment.otpauthUrl).toContain('otpauth://totp/');
      expect(enrollment.otpauthUrl).toContain(enrollment.secret);
      expect(enrollment.otpauthUrl).toContain('issuer=UNAC');
      expect(enrollment.qrDataUrl.startsWith(PNG_DATA_URL_PREFIX)).toBe(true);
      expect(enrollment.qrDataUrl).toContain(PNG_MAGIC_BASE64);
    });
  });

  describe('semilla cifrada en reposo (BE-11)', () => {
    it('sealSecret cifra (sin Base32 legible) y es idempotente', async () => {
      const { secret } = await service.createEnrollment('a@unac.edu.co', 'UNAC');
      const sealed = service.sealSecret(secret);
      expect(sealed.startsWith('enc.v1.')).toBe(true);
      expect(sealed).not.toContain(secret);
      expect(service.sealSecret(sealed)).toBe(sealed);
    });

    it('verifica contra la semilla cifrada y devuelve el paso de tiempo del código', async () => {
      const { secret } = await service.createEnrollment('a@unac.edu.co', 'UNAC');
      const code = await generate({ secret });
      const step = await service.matchTotp(code, service.sealSecret(secret));
      expect(step).toBe(Math.floor(Date.now() / 1000 / 30));
    });

    it('sigue aceptando una semilla anterior a la migración (en claro)', async () => {
      const { secret } = await service.createEnrollment('a@unac.edu.co', 'UNAC');
      expect(await service.verifyTotp(await generate({ secret }), secret)).toBe(true);
    });

    it('con otra clave no descifra: el código se rechaza, no lanza', async () => {
      const { secret } = await service.createEnrollment('a@unac.edu.co', 'UNAC');
      const sealed = service.sealSecret(secret);
      const other = new MfaService(cipherWithKey('otra-clave'));
      expect(await other.matchTotp(await generate({ secret }), sealed)).toBeNull();
    });
  });
});
