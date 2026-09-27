import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import type { AppConfig } from '../../config/configuration.js';
import type { StorageSettings } from './entities/storage-settings.entity.js';
import { StorageService } from './storage.service.js';

const DEPLOYED = path.resolve('/data/storage');

const build = (row: Partial<StorageSettings> | null) => {
  const save = vi.fn(async (value: StorageSettings) => value);
  const settings = {
    find: vi.fn(async () => (row ? [row] : [])),
    save,
    create: vi.fn((value: Partial<StorageSettings>) => value),
  } as unknown as Repository<StorageSettings>;
  const values: Record<string, unknown> = {
    storage: {
      driver: 'project',
      projectPath: DEPLOYED,
      s3: { provider: 'minio', endpoint: null, region: 'us-east-1', bucket: null, accessKey: null, secretKey: null, forcePathStyle: true },
      google: { clientId: null, clientSecret: null, refreshToken: null, folderId: null },
      onedrive: { tenantId: null, clientId: null, clientSecret: null, refreshToken: null, folderId: null },
    },
    apiPublicUrl: 'http://api',
  };
  const config = {
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService<AppConfig, true>;
  return { service: new StorageService(settings, config), save };
};

describe('StorageService: carpeta del driver project (BE-01)', () => {
  it('PATCH con projectPath "/" responde 400 STORAGE_PROJECT_PATH_LOCKED y no guarda', async () => {
    const { service, save } = build({ driver: 'project', projectPath: DEPLOYED });
    await expect(service.updateSettings({ projectPath: '/' }, 'actor')).rejects.toMatchObject({
      code: ErrorCode.StorageProjectPathLocked,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('acepta reenviar el mismo valor que devuelve el estado (el formulario lo hace)', async () => {
    const { service, save } = build({ driver: 'project', projectPath: DEPLOYED });
    const status = await service.status();
    await service.updateSettings({ projectPath: status.projectPath, driver: 'project' }, 'actor');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ projectPath: DEPLOYED });
  });

  it('ignora una project_path distinta guardada en la BD: el estado muestra la del despliegue', async () => {
    const { service } = build({ driver: 'project', projectPath: '/' });
    const status = await service.status();
    expect(status.projectPath).toBe(DEPLOYED);
  });

  it('GET /storage/objects?key=/proc/self/environ no llega al disco aunque la fila tenga "/"', async () => {
    const { service } = build({ driver: 'project', projectPath: '/' });
    await expect(service.get('proc/self/environ')).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
    await expect(service.get('/proc/self/environ')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.getFrom('s3', '../x')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.exists('a/../../x')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.delete('/etc/hostname')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.presignGet('a\u0000b')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
  });
});
