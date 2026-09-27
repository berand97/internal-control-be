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

/**
 * TOTP. Las semillas se guardan cifradas (BE-11, AES-256-GCM de SecretCipherService, clave SETTINGS_ENCRYPTION_KEY):
 * sealSecret antes de escribir, y aquí se descifran solo para verificar. Una semilla aún en claro (fila anterior a la
 * migración) se sigue aceptando: decrypt la devuelve tal cual.
 */
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

  /** Semilla lista para guardar en app_user (idempotente: una ya cifrada no se vuelve a cifrar). */
  sealSecret(secret: string): string {
    const sealed = this.cipher.encrypt(secret);
    if (sealed === null) {
      throw new Error('Semilla TOTP vacía');
    }
    return sealed;
  }

  /**
   * Paso de tiempo (RFC 6238, T = floor(epoch / 30)) en que coincide el código, o null si no coincide. Lo usa quien
   * debe impedir la reutilización del mismo código dentro de su ventana (MfaAccountService.acceptTotp).
   */
  async matchTotp(code: string, storedSecret: string): Promise<number | null> {
    let secret: string | null;
    try {
      secret = this.cipher.decrypt(storedSecret);
    } catch {
      // Sin la semilla ni el código en el log: solo que no se pudo descifrar (clave cambiada o dato corrupto).
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
