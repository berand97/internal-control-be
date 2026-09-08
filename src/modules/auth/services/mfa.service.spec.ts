import { describe, expect, it } from 'vitest';
import { MfaService } from './mfa.service.js';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC_BASE64 = 'iVBORw0KGgo';

describe('MfaService', () => {
  const service = new MfaService();

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
});
