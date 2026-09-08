import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

const QR_SIZE_PX = 280;
const QR_MARGIN_MODULES = 4;

export interface MfaEnrollment {
  readonly secret: string;
  readonly otpauthUrl: string;
  readonly qrDataUrl: string;
}

@Injectable()
export class MfaService {
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

  async verifyTotp(code: string, secret: string): Promise<boolean> {
    try {
      const result = await verify({ token: code, secret });
      return result.valid;
    } catch {
      return false;
    }
  }
}
