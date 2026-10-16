import sharp, { type Metadata } from 'sharp';
import type { EmailAssetMime } from '../entities/email-asset.entity.js';

export const EMAIL_IMAGE_LIMITS = {
  maxBytes: 1024 * 1024,
  maxInputPixels: 100_000_000,
  maxStoredWidth: 1200,
  maxStoredHeight: 2000,
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

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

const sharpInput = (bytes: Buffer) =>
  sharp(bytes, { failOn: 'error', animated: false, limitInputPixels: EMAIL_IMAGE_LIMITS.maxInputPixels });

const isPixelLimitError = (error: unknown): boolean => error instanceof Error && /pixel limit/i.test(error.message);

const rejectionFor = (error: unknown): EmailImageRejectedError =>
  new EmailImageRejectedError(isPixelLimitError(error) ? 'TOO_MANY_PIXELS' : 'UNREADABLE');

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
