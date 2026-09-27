import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { EMAIL_ASSET_CACHE_CONTROL, EmailAssetUploadsService, emailAssetKey } from './email-asset-uploads.service.js';

const KEY = /^images\/email\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

describe('EmailAssetUploadsService.upload', () => {
  let storage: { putPublicAsset: ReturnType<typeof vi.fn>; deletePublicAsset: ReturnType<typeof vi.fn> };
  let repo: { findOneBy: ReturnType<typeof vi.fn>; findOneByOrFail: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  let service: EmailAssetUploadsService;
  let png: Buffer;

  beforeEach(async () => {
    png = await sharp({ create: { width: 30, height: 10, channels: 3, background: '#306999' } }).png().toBuffer();
    storage = {
      putPublicAsset: vi.fn(async (input: { key: string }) => ({ key: input.key, publicUrl: `https://cdn.test/b/${input.key}` })),
      deletePublicAsset: vi.fn(async () => undefined),
    };
    repo = {
      findOneBy: vi.fn(async () => null),
      findOneByOrFail: vi.fn(async (where: { id?: string }) => ({
        id: where.id ?? 'x',
        storageKey: 'k',
        publicUrl: 'https://cdn.test/b/k',
        mime: 'image/png',
        byteSize: 10,
        width: 30,
        height: 10,
        sha256: 'h',
        originalName: 'logo.png',
        createdBy: 'actor',
        createdAt: new Date('2026-09-27T00:00:00Z'),
      })),
      query: vi.fn(async (_sql: string, params: ReadonlyArray<unknown>) => [{ id: params[0] }]),
    };
    service = new EmailAssetUploadsService(repo as never, storage as never);
  });

  it('sube al bucket público con clave images/email/<uuid>.png (sin el nombre original), Content-Type y caché inmutable', async () => {
    await service.upload({ buffer: png, originalname: 'Mi logo secreto.png' }, 'actor');
    expect(storage.putPublicAsset).toHaveBeenCalledTimes(1);
    const input = storage.putPublicAsset.mock.calls[0]?.[0] as { key: string; contentType: string; cacheControl: string; body: Buffer };
    expect(input.key).toMatch(KEY);
    expect(input.key).not.toContain('logo');
    expect(input).toMatchObject({ contentType: 'image/png', cacheControl: EMAIL_ASSET_CACHE_CONTROL });
    expect(input.cacheControl).toBe('public, max-age=31536000, immutable');
    const params = repo.query.mock.calls[0]?.[1] as ReadonlyArray<unknown>;
    expect(params[1]).toBe(input.key);
    expect(params[2]).toBe(`https://cdn.test/b/${input.key}`);
    expect(params[0]).toBe(input.key.slice('images/email/'.length, -'.png'.length));
    expect(params[8]).toBe('Mi logo secreto.png');
  });

  it('la misma imagen ya guardada: devuelve la existente sin subir nada', async () => {
    repo.findOneBy.mockResolvedValueOnce({ id: 'existente', publicUrl: 'https://cdn.test/b/x', createdAt: new Date() });
    const result = await service.upload({ buffer: png }, 'actor');
    expect(result.id).toBe('existente');
    expect(storage.putPublicAsset).not.toHaveBeenCalled();
  });

  it('carrera por el mismo sha256: borra el objeto duplicado y devuelve la ganadora', async () => {
    repo.query.mockResolvedValueOnce([]);
    await service.upload({ buffer: png }, 'actor');
    const key = (storage.putPublicAsset.mock.calls[0] as [{ key: string }])[0].key;
    expect(storage.deletePublicAsset).toHaveBeenCalledWith(key);
  });

  it('carrera por el mismo sha256 y el borrado del duplicado falla: solo se registra y se devuelve la ganadora', async () => {
    repo.query.mockResolvedValueOnce([]);
    storage.deletePublicAsset.mockRejectedValueOnce(new Error('AccessDenied'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const result = await service.upload({ buffer: png }, 'actor');
      expect(result.id).toBe('x');
      expect(storage.deletePublicAsset).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^No se pudo borrar el objeto duplicado images\/email\//);
    } finally {
      warn.mockRestore();
    }
  });

  it('sin bucket público: el error de configuración sale tal cual y no se inserta nada', async () => {
    storage.putPublicAsset.mockRejectedValueOnce(new ApiException(ErrorCode.PublicAssetsNotConfigured));
    await expect(service.upload({ buffer: png }, 'actor')).rejects.toMatchObject({ code: ErrorCode.PublicAssetsNotConfigured });
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('SVG o GIF: FILE_TYPE_NOT_ALLOWED antes de tocar el almacenamiento', async () => {
    await expect(service.upload({ buffer: Buffer.from('<svg/>') }, 'actor')).rejects.toMatchObject({
      code: ErrorCode.FileTypeNotAllowed,
    });
    expect(storage.putPublicAsset).not.toHaveBeenCalled();
  });

  it('emailAssetKey: .jpg para JPEG', () => {
    const id = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    expect(emailAssetKey(id, 'image/jpeg')).toBe(`images/email/${id}.jpg`);
  });
});
