import { Injectable, Logger } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { SecretCipherService } from '../../../shared/crypto/secret-cipher.service.js';

const QR_SIZE_PX = 280;
const QR_MARGIN_MODULES = 4;

export interface MfaEnrollment {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly qrDataUrl: string;
}

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(private readonly cipher: SecretCipherService) {}

  async createEnrollment(
    accountName: string,
    issuer: string,
  ): Promise<MfaEnrollment> {
    const secret = generateSecret();
    const otpauthUrl = generateURI({
      issuer,
      label: accountName,
      secret,
    });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: QR_SIZE_PX,
      margin: QR_MARGIN_MODULES,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });
    return { secret, otpauthUrl, qrDataUrl };
  }

  sealSecret(secret: string): string {
    const sealed = this.cipher.encrypt(secret);
    if (sealed === null) {
      throw new Error('Semilla TOTP vacía');
    }
    return sealed;
  }

  async matchTotp(code: string, storedSecret: string): Promise<number | null> {
    let secret: string | null;
    try {
      secret = this.cipher.decrypt(storedSecret);
    } catch {
      this.logger.error(
        'No se pudo descifrar una semilla TOTP; ¿cambió SETTINGS_ENCRYPTION_KEY (o JWT_ACCESS_SECRET, si no está definida)?',
      );
      return null;
    }
    if (!secret) {
      return null;
    }
    try {
      const result = await verify({ token: code, secret });
      return result.valid && 'timeStep' in result ? result.timeStep : null;
    } catch {
      return null;
    }
  }

  async verifyTotp(code: string, storedSecret: string): Promise<boolean> {
    return (await this.matchTotp(code, storedSecret)) !== null;
  }
}
