import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { AssetCategory } from '../entities/asset-category.entity.js';
import { DepreciationMethod } from '../enums/depreciation-method.enum.js';
import type { CategoriesRepository } from '../repositories/categories.repository.interface.js';
import { CategoriesService } from './categories.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const category = (
  id: string,
  code: string,
  parentId: string | null,
): AssetCategory => {
  const item = new AssetCategory();
  item.id = id;
  item.parentId = parentId;
  item.code = code;
  item.name = code;
  item.description = null;
  item.depreciationYears = 5;
  item.depreciationMethod = DepreciationMethod.StraightLine;
  item.requiresSerialNumber = false;
  item.requiresPhoto = true;
  item.hierarchyPath = parentId
    ? `/computadores/${code.toLowerCase()}`
    : `/${code.toLowerCase()}`;
  item.isActive = true;
  item.createdAt = new Date();
  return item;
};

describe('CategoriesService', () => {
  let categoriesRepository: CategoriesRepository;
  let service: CategoriesService;

  beforeEach(() => {
    categoriesRepository = {
      findAll: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      countActiveChildren: vi.fn().mockResolvedValue(0),
      countAssets: vi.fn().mockResolvedValue(0),
      rewriteDescendantPaths: vi.fn(),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new CategoriesService(categoriesRepository, auditLogsRepository);
  });

  it('arma un árbol de tres niveles', async () => {
    const root = category('1', 'MUEBLES', null);
    const sillas = category('2', 'SILLAS', '1');
    sillas.hierarchyPath = '/muebles/sillas';
    const ergo = category('3', 'SILLAS_ERGONOMICAS', '2');
    ergo.hierarchyPath = '/muebles/sillas/sillas_ergonomicas';
    vi.mocked(categoriesRepository.findAll).mockResolvedValue([
      root,
      sillas,
      ergo,
    ]);
    const tree = await service.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]?.code).toBe('SILLAS_ERGONOMICAS');
  });

  it('bloquea un ciclo al reparentar hacia un descendiente', async () => {
    const root = category('1', 'MUEBLES', null);
    const child = category('2', 'SILLAS', '1');
    vi.mocked(categoriesRepository.findById).mockImplementation(async (id) => {
      if (id === '1') {
        return root;
      }
      if (id === '2') {
        return child;
      }
      return null;
    });
    await expect(
      service.update('1', { parentId: '2' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.CategoryCycle });
  });

  it('no desactiva una categoría con hijos activos', async () => {
    vi.mocked(categoriesRepository.findById).mockResolvedValue(
      category('1', 'MUEBLES', null),
    );
    vi.mocked(categoriesRepository.countActiveChildren).mockResolvedValue(2);
    await expect(service.remove('1', actor)).rejects.toMatchObject({
      code: ErrorCode.CategoryHasChildren,
    });
  });

  it('no desactiva una categoría con activos asociados', async () => {
    vi.mocked(categoriesRepository.findById).mockResolvedValue(
      category('1', 'MUEBLES', null),
    );
    vi.mocked(categoriesRepository.countAssets).mockResolvedValue(3);
    await expect(service.remove('1', actor)).rejects.toMatchObject({
      code: ErrorCode.AssetCategoryHasAssets,
    });
  });
});
