import {
  detectImageType,
  ImageRejectedError,
  type ImageRejection,
  processImage,
} from '../../../shared/images/image-processing.js';
import type { EmailAssetMime } from '../entities/email-asset.entity.js';

export const EMAIL_IMAGE_LIMITS = {
  maxBytes: 1024 * 1024,
  maxInputPixels: 100_000_000,
  maxStoredWidth: 1200,
  maxStoredHeight: 2000,
} as const;

export const detectImageMime = (bytes: Buffer): EmailAssetMime | null => {
  const mime = detectImageType(bytes);
  return mime === 'image/png' || mime === 'image/jpeg' ? mime : null;
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

const EMAIL_REJECTION: Readonly<Record<ImageRejection, EmailImageRejection>> = {
  UNSUPPORTED_TYPE: 'NOT_PNG_OR_JPEG',
  UNREADABLE: 'UNREADABLE',
  TOO_MANY_PIXELS: 'TOO_MANY_PIXELS',
};

const EMAIL_MIMES: ReadonlyArray<EmailAssetMime> = ['image/png', 'image/jpeg'];

export const processEmailImage = async (bytes: Buffer): Promise<ProcessedEmailImage> => {
  try {
    const processed = await processImage(bytes, {
      allowed: EMAIL_MIMES,
      maxWidth: EMAIL_IMAGE_LIMITS.maxStoredWidth,
      maxHeight: EMAIL_IMAGE_LIMITS.maxStoredHeight,
      maxInputPixels: EMAIL_IMAGE_LIMITS.maxInputPixels,
    });
    const mime = EMAIL_MIMES.find((item) => item === processed.mime);
    if (!mime) {
      throw new EmailImageRejectedError('NOT_PNG_OR_JPEG');
    }
    return { mime, content: processed.content, width: processed.width, height: processed.height };
  } catch (error) {
    if (error instanceof ImageRejectedError) {
      throw new EmailImageRejectedError(EMAIL_REJECTION[error.reason]);
    }
    throw error;
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
