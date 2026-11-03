import sharp, { type Metadata, type Sharp } from 'sharp';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export type ImageExtension = 'png' | 'jpg' | 'webp';

export const IMAGE_EXTENSION: Readonly<Record<ImageMime, ImageExtension>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const DEFAULT_MAX_INPUT_PIXELS = 100_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF = Buffer.from('RIFF', 'latin1');
const WEBP = Buffer.from('WEBP', 'latin1');

const startsWith = (bytes: Buffer, signature: Buffer, offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  bytes.subarray(offset, offset + signature.length).equals(signature);

export const detectImageType = (bytes: Buffer): ImageMime | null => {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return 'image/webp';
  }
  return null;
};

export type ImageRejection = 'UNSUPPORTED_TYPE' | 'UNREADABLE' | 'TOO_MANY_PIXELS';

export class ImageRejectedError extends Error {
  constructor(readonly reason: ImageRejection) {
    super(reason);
  }
}

export interface ImageProcessingOptions {
  readonly allowed: ReadonlyArray<ImageMime>;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxInputPixels?: number;
}

export interface ProcessedImage {
  readonly mime: ImageMime;
  readonly content: Buffer;
  readonly width: number;
  readonly height: number;
}

const SHARP_FORMAT: Readonly<Record<ImageMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

const sharpInput = (bytes: Buffer, maxInputPixels: number): Sharp =>
  sharp(bytes, { failOn: 'error', animated: false, limitInputPixels: maxInputPixels });

const isPixelLimitError = (error: unknown): boolean => error instanceof Error && /pixel limit/i.test(error.message);

const rejectionFor = (error: unknown): ImageRejectedError =>
  new ImageRejectedError(isPixelLimitError(error) ? 'TOO_MANY_PIXELS' : 'UNREADABLE');

const encode = (pipeline: Sharp, mime: ImageMime): Sharp => {
  switch (mime) {
    case 'image/png':
      return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    case 'image/jpeg':
      return pipeline.jpeg({ quality: 85, mozjpeg: true });
    case 'image/webp':
      return pipeline.webp({ quality: 85 });
  }
};

export const processImage = async (bytes: Buffer, options: ImageProcessingOptions): Promise<ProcessedImage> => {
  const maxInputPixels = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;
  const mime = detectImageType(bytes);
  if (mime === null || !options.allowed.includes(mime)) {
    throw new ImageRejectedError('UNSUPPORTED_TYPE');
  }
  let metadata: Metadata;
  try {
    metadata = await sharpInput(bytes, maxInputPixels).metadata();
  } catch (error) {
    throw rejectionFor(error);
  }
  if (metadata.format !== SHARP_FORMAT[mime]) {
    throw new ImageRejectedError('UNSUPPORTED_TYPE');
  }
  if (!metadata.width || !metadata.height) {
    throw new ImageRejectedError('UNREADABLE');
  }
  if (metadata.width * metadata.height > maxInputPixels) {
    throw new ImageRejectedError('TOO_MANY_PIXELS');
  }
  try {
    const pipeline = sharpInput(bytes, maxInputPixels).rotate().resize({
      width: options.maxWidth,
      height: options.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const { data, info } = await encode(pipeline, mime).toBuffer({ resolveWithObject: true });
    return { mime, content: data, width: info.width, height: info.height };
  } catch (error) {
    throw rejectionFor(error);
  }
};

export const webpThumbnail = async (bytes: Buffer, maxSide: number): Promise<ProcessedImage> => {
  try {
    const { data, info } = await sharpInput(bytes, DEFAULT_MAX_INPUT_PIXELS)
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer({ resolveWithObject: true });
    return { mime: 'image/webp', content: data, width: info.width, height: info.height };
  } catch (error) {
    throw rejectionFor(error);
  }
};
