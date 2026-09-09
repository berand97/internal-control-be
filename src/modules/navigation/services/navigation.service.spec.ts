import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { NavigationItemEntity } from '../entities/navigation-item.entity.js';
import type { NavigationRepository } from '../repositories/navigation.repository.interface.js';
import { NavigationService } from './navigation.service.js';

const item = (): NavigationItemEntity => {
  const row = new NavigationItemEntity();
  row.id = 'nav-1';
  row.module = 'ASSET';
  row.moduleLabel = 'Activos';
  row.resource = 'asset';
  row.path = '/assets';
  row.label = 'Activos';
  row.requiredAction = 'read';
  row.sortOrder = 70;
  row.isActive = true;
  row.createdAt = new Date();
  row.updatedAt = new Date();
  return row;
};

describe('NavigationService', () => {
  let repository: NavigationRepository;
  let service: NavigationService;

  beforeEach(() => {
    repository = {
      findAll: vi.fn(),
      findActive: vi.fn().mockResolvedValue([item()]),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    service = new NavigationService(repository);
  });

  it('cachea el catálogo activo', async () => {
    await service.listActiveDefinitions();
    await service.listActiveDefinitions();
    expect(repository.findActive).toHaveBeenCalledTimes(1);
  });

  it('invalida el cache al crear', async () => {
    vi.mocked(repository.insert).mockResolvedValue(item());
    await service.listActiveDefinitions();
    await service.create({
      module: 'ASSET',
      moduleLabel: 'Activos',
      resource: 'asset',
      path: '/assets',
      label: 'Activos',
      requiredAction: 'read',
    });
    await service.listActiveDefinitions();
    expect(repository.findActive).toHaveBeenCalledTimes(2);
  });

  it('rechaza eliminar un ítem inexistente', async () => {
    vi.mocked(repository.delete).mockResolvedValue(false);
    await expect(service.remove('missing')).rejects.toMatchObject({
      code: ErrorCode.ResourceNotFound,
    });
  });
});
