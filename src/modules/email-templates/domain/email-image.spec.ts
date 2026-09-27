import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_IMAGE_LIMITS,
  EmailImageRejectedError,
  detectImageMime,
  processEmailImage,
  sanitizeAssetName,
} from './email-image.js';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 48, g: 105, b: 153 } } });

const png = (width = 40, height = 20) => solid(width, height).png().toBuffer();
const jpeg = (width = 40, height = 20) => solid(width, height).jpeg().toBuffer();

const rejection = async (bytes: Buffer): Promise<string> => {
  try {
    await processEmailImage(bytes);
    return 'ACCEPTED';
  } catch (error) {
    return error instanceof EmailImageRejectedError ? error.reason : `OTHER: ${String(error)}`;
  }
};

describe('detectImageMime (bytes mágicos)', () => {
  it('reconoce PNG y JPEG por sus primeros bytes', async () => {
    expect(detectImageMime(await png())).toBe('image/png');
    expect(detectImageMime(await jpeg())).toBe('image/jpeg');
  });

  it.each([
    ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML renombrado a .png', Buffer.from('<!DOCTYPE html><html><body>hola</body></html>')],
    ['WebP', Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')],
    ['vacío', Buffer.alloc(0)],
    ['PNG sin la firma completa', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ])('rechaza %s', async (_name, bytes) => {
    expect(detectImageMime(bytes)).toBeNull();
    expect(await rejection(bytes)).toBe('NOT_PNG_OR_JPEG');
  });

  it('un GIF real (sharp) también se rechaza', async () => {
    expect(await rejection(await solid(10, 10).gif().toBuffer())).toBe('NOT_PNG_OR_JPEG');
  });
});

describe('processEmailImage', () => {
  it('PNG válido: se re-codifica como PNG con su tamaño', async () => {
    const result = await processEmailImage(await png(40, 20));
    expect(result).toMatchObject({ mime: 'image/png', width: 40, height: 20 });
    expect(detectImageMime(result.content)).toBe('image/png');
  });

  it('JPEG progresivo válido: se acepta y sale como JPEG', async () => {
    const progressive = await solid(64, 32).jpeg({ progressive: true }).toBuffer();
    const result = await processEmailImage(progressive);
    expect(result).toMatchObject({ mime: 'image/jpeg', width: 64, height: 32 });
  });

  it('quita EXIF y GPS del JPEG y aplica la orientación a los píxeles', async () => {
    const withExif = await solid(60, 30)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({
        IFD0: { Make: 'Camara', Model: 'Modelo secreto' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 15/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '75/1 34/1 0/1' },
      })
      .toBuffer();
    const before = await sharp(withExif).metadata();
    expect(before.exif).toBeDefined();
    expect(before.exif?.toString('latin1')).toContain('Modelo secreto');
    expect(before.orientation).toBe(6);
    const result = await processEmailImage(withExif);
    const after = await sharp(result.content).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(result.content.toString('latin1')).not.toContain('Modelo secreto');
    // Orientation 6 = rotar 90°: la imagen guardada ya viene girada.
    expect(result).toMatchObject({ width: 30, height: 60 });
  });

  it(`reduce a ${EMAIL_IMAGE_LIMITS.maxStoredWidth} px de ancho, conservando la proporción`, async () => {
    const result = await processEmailImage(await png(1800, 900));
    expect(result).toMatchObject({ width: EMAIL_IMAGE_LIMITS.maxStoredWidth, height: 600 });
  });

  it('el tamaño en píxeles no se rechaza: 3000 × 1500 (pocos KB) se guarda a 1200 × 600', async () => {
    const wide = await png(3000, 1500);
    expect(wide.length).toBeLessThan(EMAIL_IMAGE_LIMITS.maxBytes);
    const result = await processEmailImage(wide);
    expect(result).toMatchObject({ mime: 'image/png', width: 1200, height: 600 });
    const stored = await sharp(result.content).metadata();
    expect(stored).toMatchObject({ width: 1200, height: 600 });
  });

  it('12000 × 8000 (96 megapíxeles, JPEG de un color) se acepta y se reduce a 1200 × 800', async () => {
    const result = await processEmailImage(await jpeg(12000, 8000));
    expect(result).toMatchObject({ mime: 'image/jpeg', width: 1200, height: 800 });
  });

  it(`una tira alta y angosta se reduce hasta caber en ${EMAIL_IMAGE_LIMITS.maxStoredWidth} × ${EMAIL_IMAGE_LIMITS.maxStoredHeight}`, async () => {
    const result = await processEmailImage(await png(1000, 5000));
    expect(result).toMatchObject({ width: 400, height: EMAIL_IMAGE_LIMITS.maxStoredHeight });
  });

  it('más de 100 megapíxeles (PNG de un color, pesa poco): TOO_MANY_PIXELS, también al leer la cabecera', async () => {
    const bomb = await solid(10240, 10240).png({ compressionLevel: 9 }).toBuffer();
    expect(10240 * 10240).toBeGreaterThan(EMAIL_IMAGE_LIMITS.maxInputPixels);
    expect(await rejection(bomb)).toBe('TOO_MANY_PIXELS');
  });

  it('sin ancho ni alto legibles (PNG con IHDR 0 × 0): UNREADABLE, no un mensaje de tamaño', async () => {
    const good = await png(40, 20);
    const zero = Buffer.from(good);
    // IHDR: firma (8) + longitud (4) + "IHDR" (4) → ancho en 16..19 y alto en 20..23 (el CRC deja de cuadrar:
    // sharp no la lee, y si la leyera sin ancho/alto también sería UNREADABLE).
    zero.writeUInt32BE(0, 16);
    zero.writeUInt32BE(0, 20);
    expect(await rejection(zero)).toBe('UNREADABLE');
  });

  it('rechaza una imagen dañada o un JPEG con cola de otro formato por la firma', async () => {
    const good = await png(40, 20);
    expect(await rejection(good.subarray(0, 40))).toBe('UNREADABLE');
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<svg></svg>')]);
    expect(await rejection(fake)).toBe('UNREADABLE');
    // Firma PNG delante de un JPEG real: el formato real no coincide.
    const disguised = Buffer.concat([good.subarray(0, 8), (await jpeg()).subarray(8)]);
    expect(['UNREADABLE', 'NOT_PNG_OR_JPEG']).toContain(await rejection(disguised));
  });
});

describe('sanitizeAssetName', () => {
  it.each([
    ['logo.png', 'logo.png'],
    ['C:\\fakepath\\Logo UNAC (2026).png', 'Logo UNAC (2026).png'],
    ['../../etc/passwd', 'passwd'],
    ['<script>alert(1)</script>.png', 'script_.png'],
    ['<img onerror=x>.png', '_img onerror_x_.png'],
    ['firma\u0000\u200b.jpg', 'firma__.jpg'],
    ['', 'imagen'],
    [undefined, 'imagen'],
    ['...', 'imagen'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeAssetName(input)).toBe(expected);
  });

  it('corta a 120 caracteres', () => {
    expect(sanitizeAssetName(`${'a'.repeat(200)}.png`)).toHaveLength(120);
  });
});
