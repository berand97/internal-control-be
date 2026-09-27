import sharp, { type Metadata } from 'sharp';
import type { EmailAssetMime } from '../entities/email-asset.entity.js';

/**
 * Imágenes de las plantillas de correo: validación por bytes mágicos (no por la extensión ni por el Content-Type
 * que declara el navegador) y re-codificación con sharp. Re-codificar quita todos los metadatos (EXIF, GPS, XMP,
 * perfiles ICC: la imagen queda en sRGB), aplica la orientación EXIF a los píxeles y la reduce hasta caber en
 * `maxStoredWidth` × `maxStoredHeight`. Solo PNG y JPEG: Gmail y Outlook no muestran SVG, y un GIF o WebP no aporta
 * nada aquí. El tamaño en píxeles de la imagen subida no se rechaza (se reduce): el único tope es `maxInputPixels`,
 * contra bombas de descompresión (un PNG de un solo color de pocos KB puede declarar cientos de megapíxeles).
 */

export const EMAIL_IMAGE_LIMITS = {
  /** Tamaño del archivo subido (multipart). */
  maxBytes: 1024 * 1024,
  /**
   * Píxeles (ancho × alto) que se aceptan decodificar: 100 megapíxeles (12000 × 8000 cabe). Solo protege contra
   * bombas de descompresión; cualquier imagen por debajo se acepta y se reduce.
   */
  maxInputPixels: 100_000_000,
  /** Ancho máximo de la imagen guardada (el correo la muestra a 560 px como mucho; 1200 cubre pantallas 2x). */
  maxStoredWidth: 1200,
  /**
   * Alto máximo de la imagen guardada: una tira alta y angosta (p. ej. 1000 × 5000) se reduce, conservando la
   * proporción, hasta caber en 1200 × 2000 (queda 400 × 2000). 2000 es el tope de chk_email_asset_height (migración
   * 1767225820000) y ya son más de tres pantallas de correo.
   */
  maxStoredHeight: 2000,
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

export type EmailImageRejection = 'NOT_PNG_OR_JPEG' | 'UNREADABLE' | 'TOO_MANY_PIXELS';

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

/** Mismas opciones para leer la cabecera y para decodificar: el tope de píxeles se aplica en las dos. */
const sharpInput = (bytes: Buffer) =>
  sharp(bytes, { failOn: 'error', animated: false, limitInputPixels: EMAIL_IMAGE_LIMITS.maxInputPixels });

/** sharp/libvips al superar limitInputPixels: "Input image exceeds pixel limit". */
const isPixelLimitError = (error: unknown): boolean => error instanceof Error && /pixel limit/i.test(error.message);

const rejectionFor = (error: unknown): EmailImageRejectedError =>
  new EmailImageRejectedError(isPixelLimitError(error) ? 'TOO_MANY_PIXELS' : 'UNREADABLE');

/**
 * Valida y re-codifica. Lanza EmailImageRejectedError: NOT_PNG_OR_JPEG (bytes mágicos o formato real distinto),
 * TOO_MANY_PIXELS (más de maxInputPixels) o UNREADABLE (dañada, truncada o sin ancho/alto legibles).
 */
export const processEmailImage = async (bytes: Buffer): Promise<ProcessedEmailImage> => {
  const mime = detectImageMime(bytes);
  if (mime === null) {
    throw new EmailImageRejectedError('NOT_PNG_OR_JPEG');
  }
  let metadata: Metadata;
  try {
    metadata = await sharpInput(bytes).metadata();
  } catch (error) {
    throw rejectionFor(error);
  }
  if (metadata.format !== SHARP_FORMAT[mime]) {
    throw new EmailImageRejectedError('NOT_PNG_OR_JPEG');
  }
  if (!metadata.width || !metadata.height) {
    throw new EmailImageRejectedError('UNREADABLE');
  }
  if (metadata.width * metadata.height > EMAIL_IMAGE_LIMITS.maxInputPixels) {
    throw new EmailImageRejectedError('TOO_MANY_PIXELS');
  }
  try {
    // rotate() antes de reducir: la orientación EXIF decide cuál lado es el ancho.
    const pipeline = sharpInput(bytes).rotate().resize({
      width: EMAIL_IMAGE_LIMITS.maxStoredWidth,
      height: EMAIL_IMAGE_LIMITS.maxStoredHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const encoded =
      mime === 'image/png'
        ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
        : pipeline.jpeg({ quality: 85, mozjpeg: true });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { mime, content: data, width: info.width, height: info.height };
  } catch (error) {
    throw rejectionFor(error);
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
