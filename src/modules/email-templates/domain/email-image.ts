import sharp, { type Metadata } from 'sharp';
import type { EmailAssetMime } from '../entities/email-asset.entity.js';

/**
 * Imágenes de las plantillas de correo: validación por bytes mágicos (no por la extensión ni por el Content-Type
 * que declara el navegador) y re-codificación con sharp. Re-codificar quita todos los metadatos (EXIF, GPS, XMP,
 * perfiles ICC: la imagen queda en sRGB), aplica la orientación EXIF a los píxeles y reduce el ancho a
 * `maxStoredWidth`. Solo PNG y JPEG: Gmail y Outlook no muestran SVG, y un GIF o WebP no aporta nada aquí.
 */

export const EMAIL_IMAGE_LIMITS = {
  /** Tamaño del archivo subido (multipart). */
  maxBytes: 1024 * 1024,
  /** Ancho y alto máximos de la imagen subida, en px. */
  maxInputDimension: 2000,
  /** Ancho máximo de la imagen guardada (el correo la muestra a 560 px como mucho; 1200 cubre pantallas 2x). */
  maxStoredWidth: 1200,
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Tipo por los primeros bytes; null si no es PNG ni JPEG. */
export const detectImageMime = (bytes: Buffer): EmailAssetMime | null => {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes.length >= JPEG_SIGNATURE.length && bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  return null;
};

export type EmailImageRejection = 'NOT_PNG_OR_JPEG' | 'UNREADABLE' | 'TOO_LARGE_DIMENSIONS';

export class EmailImageRejectedError extends Error {
  constructor(readonly reason: EmailImageRejection) {
    super(reason);
  }
}

export interface ProcessedEmailImage {
  readonly mime: EmailAssetMime;
  readonly content: Buffer;
  readonly width: number;
  readonly height: number;
}

const SHARP_FORMAT: Record<EmailAssetMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg' };

const sharpInput = (bytes: Buffer) =>
  sharp(bytes, {
    failOn: 'error',
    animated: false,
    limitInputPixels: EMAIL_IMAGE_LIMITS.maxInputDimension * EMAIL_IMAGE_LIMITS.maxInputDimension,
  });

/**
 * Valida y re-codifica. Lanza EmailImageRejectedError: NOT_PNG_OR_JPEG (bytes mágicos o formato real distinto),
 * TOO_LARGE_DIMENSIONS (más de maxInputDimension de ancho o alto) o UNREADABLE (dañada o truncada).
 */
export const processEmailImage = async (bytes: Buffer): Promise<ProcessedEmailImage> => {
  const mime = detectImageMime(bytes);
  if (mime === null) {
    throw new EmailImageRejectedError('NOT_PNG_OR_JPEG');
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { failOn: 'error', animated: false }).metadata();
  } catch {
    throw new EmailImageRejectedError('UNREADABLE');
  }
  if (metadata.format !== SHARP_FORMAT[mime]) {
    throw new EmailImageRejectedError('NOT_PNG_OR_JPEG');
  }
  const max = EMAIL_IMAGE_LIMITS.maxInputDimension;
  if (!metadata.width || !metadata.height || metadata.width > max || metadata.height > max) {
    throw new EmailImageRejectedError('TOO_LARGE_DIMENSIONS');
  }
  try {
    const pipeline = sharpInput(bytes)
      .rotate()
      .resize({ width: EMAIL_IMAGE_LIMITS.maxStoredWidth, withoutEnlargement: true });
    const encoded =
      mime === 'image/png'
        ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
        : pipeline.jpeg({ quality: 85, mozjpeg: true });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { mime, content: data, width: info.width, height: info.height };
  } catch {
    throw new EmailImageRejectedError('UNREADABLE');
  }
};

/** Nombre original saneado para mostrarlo: sin ruta ni caracteres de control, máximo 120. */
export const sanitizeAssetName = (name: string | undefined): string => {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return clean === '' || /^[._]+$/.test(clean) ? 'imagen' : clean;
};
