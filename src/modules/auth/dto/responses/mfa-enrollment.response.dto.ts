import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MfaEnrollmentResponseDto {
  @ApiProperty({
    description:
      'Secreto TOTP en Base32. Fallback si el usuario no puede escanear el QR.',
    example: 'JBSWY3DPEHPK3PXP',
  })
  readonly secret!: string;

  @ApiPropertyOptional({
    description:
      'URI otpauth usada para generar el QR. El front no la necesita si viene qrDataUrl.',
    example: 'otpauth://totp/UNAC:admin?secret=JBSWY3DPEHPK3PXP&issuer=UNAC',
  })
  readonly otpauthUrl!: string;

  @ApiProperty({
    description:
      'PNG del QR en data URL para <img src>. Generado en servidor a partir de otpauthUrl; no se persiste.',
    example: 'data:image/png;base64,iVBORw0KGgo...',
  })
  readonly qrDataUrl!: string;

  static from(
    secret: string,
    otpauthUrl: string,
    qrDataUrl: string,
  ): MfaEnrollmentResponseDto {
    return { secret, otpauthUrl, qrDataUrl };
  }
}
