import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectImageType, ImageRejectedError, processImage, webpThumbnail } from './image-processing.js';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 48, g: 105, b: 153 } } });

const PHOTO = { allowed: ['image/jpeg', 'image/png', 'image/webp'] as const, maxWidth: 2560, maxHeight: 2560 };

const rejection = async (bytes: Buffer, options = PHOTO): Promise<string> => {
  try {
    await processImage(bytes, options);
    return 'ACCEPTED';
  } catch (error) {
    return error instanceof ImageRejectedError ? error.reason : `OTHER: ${String(error)}`;
  }
};

describe('detectImageType', () => {
  it('reconoce PNG, JPEG y WebP por sus bytes', async () => {
    expect(detectImageType(await solid(4, 4).png().toBuffer())).toBe('image/png');
    expect(detectImageType(await solid(4, 4).jpeg().toBuffer())).toBe('image/jpeg');
    expect(detectImageType(await solid(4, 4).webp().toBuffer())).toBe('image/webp');
  });

  it.each([
    ['GIF', Buffer.from('GIF89a', 'latin1')],
    ['RIFF que no es WebP', Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1')],
    ['vacío', Buffer.alloc(0)],
  ])('no reconoce %s', (_name, bytes) => {
    expect(detectImageType(bytes)).toBeNull();
  });
});

describe('processImage', () => {
  it('WebP válido se re-codifica como WebP', async () => {
    const result = await processImage(await solid(80, 40).webp().toBuffer(), PHOTO);
    expect(result).toMatchObject({ mime: 'image/webp', width: 80, height: 40 });
    expect(detectImageType(result.content)).toBe('image/webp');
  });

  it('un tipo detectado pero no permitido se rechaza', async () => {
    const webp = await solid(10, 10).webp().toBuffer();
    expect(await rejection(webp, { ...PHOTO, allowed: ['image/png'] as never })).toBe('UNSUPPORTED_TYPE');
  });

  it('reduce a 2560 px el lado mayor', async () => {
    const result = await processImage(await solid(4000, 1000).jpeg().toBuffer(), PHOTO);
    expect(result).toMatchObject({ width: 2560, height: 640 });
  });

  it('quita EXIF y GPS', async () => {
    const withGps = await solid(60, 30)
      .jpeg()
      .withExifMerge({
        IFD0: { Model: 'Modelo secreto' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 15/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const result = await processImage(withGps, PHOTO);
    expect((await sharp(result.content).metadata()).exif).toBeUndefined();
    expect(result.content.toString('latin1')).not.toContain('Modelo secreto');
  });

  it('bytes de JPEG con contenido de otro formato: UNREADABLE', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<svg></svg>')]);
    expect(await rejection(fake)).toBe('UNREADABLE');
  });
});

describe('webpThumbnail', () => {
  it('miniatura WebP de 320 px como máximo', async () => {
    const thumb = await webpThumbnail(await solid(1000, 500).png().toBuffer(), 320);
    expect(thumb).toMatchObject({ mime: 'image/webp', width: 320, height: 160 });
    expect(detectImageType(thumb.content)).toBe('image/webp');
  });

  it('una imagen pequeña no se agranda', async () => {
    const thumb = await webpThumbnail(await solid(100, 50).png().toBuffer(), 320);
    expect(thumb).toMatchObject({ width: 100, height: 50 });
  });
});
