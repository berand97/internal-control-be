import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { AssetCategory } from '../../categories/entities/asset-category.entity.js';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import { AssetCategoryField } from '../entities/asset-category-field.entity.js';
import { DynamicFieldType } from '../enums/dynamic-field-type.enum.js';
import type { DynamicFieldsRepository } from '../repositories/dynamic-fields.repository.interface.js';
import { DynamicFieldsService } from './dynamic-fields.service.js';

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
  item.requiresSerialNumber = true;
  item.requiresPhoto = true;
  item.hierarchyPath = `/${code.toLowerCase()}`;
  item.isActive = true;
  item.createdAt = new Date();
  return item;
};

const field = (
  id: string,
  categoryId: string,
  code: string,
  type: DynamicFieldType,
  orderIndex: number,
): AssetCategoryField => {
  const item = new AssetCategoryField();
  item.id = id;
  item.categoryId = categoryId;
  item.code = code;
  item.label = code;
  item.type = type;
  item.isRequired = false;
  item.defaultValue = null;
  item.selectOptions = null;
  item.validationRules = null;
  item.orderIndex = orderIndex;
  item.isActive = true;
  return item;
};

describe('DynamicFieldsService', () => {
  let fieldsRepository: DynamicFieldsRepository;
  let service: DynamicFieldsService;

  beforeEach(() => {
    fieldsRepository = {
      findByCategory: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      findCategoryById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      deprecate: vi.fn(),
      countValues: vi.fn().mockResolvedValue(0),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new DynamicFieldsService(fieldsRepository, auditLogsRepository);
  });

  it('hereda campos de tres niveles y deja que el hijo sobreescriba por código', async () => {
    const root = category('cat-1', 'EQUIPOS', null);
    const mid = category('cat-2', 'COMPUTADORES', 'cat-1');
    const leaf = category('cat-3', 'PORTATILES', 'cat-2');
    vi.mocked(fieldsRepository.findCategoryById).mockImplementation(
      async (id) => {
        if (id === 'cat-1') {
          return root;
        }
        if (id === 'cat-2') {
          return mid;
        }
        if (id === 'cat-3') {
          return leaf;
        }
        return null;
      },
    );
    vi.mocked(fieldsRepository.findByCategory).mockImplementation(
      async (categoryId) => {
        if (categoryId === 'cat-1') {
          return [
            field('f-brand', 'cat-1', 'marca', DynamicFieldType.String, 1),
            field('f-ram-root', 'cat-1', 'ramGB', DynamicFieldType.Number, 2),
          ];
        }
        if (categoryId === 'cat-2') {
          return [
            field('f-cpu', 'cat-2', 'procesador', DynamicFieldType.String, 3),
          ];
        }
        return [
          field('f-ram-leaf', 'cat-3', 'ramGB', DynamicFieldType.Number, 4),
          field(
            'f-screen',
            'cat-3',
            'tamanoPantallaPulgadas',
            DynamicFieldType.Number,
            5,
          ),
        ];
      },
    );

    const effective = await service.effectiveFields('cat-3');
    expect(effective.map((item) => item.code)).toEqual([
      'marca',
      'procesador',
      'ramGB',
      'tamanoPantallaPulgadas',
    ]);
    const ram = effective.find((item) => item.code === 'ramGB');
    expect(ram?.id).toBe('f-ram-leaf');
    expect(ram?.inherited).toBe(false);
    expect(effective.find((item) => item.code === 'marca')?.inherited).toBe(
      true,
    );
  });

  it('permite renombrar el código de un campo', async () => {
    const existing = field(
      'f-1',
      'cat-1',
      'ramGB',
      DynamicFieldType.Number,
      1,
    );
    const renamed = field(
      'f-1',
      'cat-1',
      'memoriaRamGb',
      DynamicFieldType.Number,
      1,
    );
    vi.mocked(fieldsRepository.findCategoryById).mockResolvedValue(
      category('cat-1', 'COMPUTADORES', null),
    );
    vi.mocked(fieldsRepository.findById)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(renamed);
    const result = await service.update(
      'cat-1',
      'f-1',
      { code: 'memoriaRamGb' },
      actor,
    );
    expect(fieldsRepository.update).toHaveBeenCalledWith('f-1', {
      code: 'memoriaRamGb',
    });
    expect(result.code).toBe('memoriaRamGb');
  });

  it('impide cambiar el tipo de un campo existente', async () => {
    const existing = field(
      'f-1',
      'cat-1',
      'hostname',
      DynamicFieldType.String,
      1,
    );
    vi.mocked(fieldsRepository.findCategoryById).mockResolvedValue(
      category('cat-1', 'COMPUTADORES', null),
    );
    vi.mocked(fieldsRepository.findById).mockResolvedValue(existing);
    await expect(
      service.update(
        'cat-1',
        'f-1',
        { type: DynamicFieldType.Number },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.DynamicFieldTypeImmutable });
  });

  it('bloquea el borrado si el campo ya tiene valores en activos', async () => {
    vi.mocked(fieldsRepository.findCategoryById).mockResolvedValue(
      category('cat-1', 'COMPUTADORES', null),
    );
    vi.mocked(fieldsRepository.findById).mockResolvedValue(
      field('f-1', 'cat-1', 'hostname', DynamicFieldType.String, 1),
    );
    vi.mocked(fieldsRepository.countValues).mockResolvedValue(4);
    await expect(service.remove('cat-1', 'f-1', actor)).rejects.toMatchObject({
      code: ErrorCode.DynamicFieldInUse,
    });
  });

  it('depreca un campo dejándolo inactivo', async () => {
    const existing = field(
      'f-1',
      'cat-1',
      'hostname',
      DynamicFieldType.String,
      1,
    );
    const deprecated = field(
      'f-1',
      'cat-1',
      'hostname',
      DynamicFieldType.String,
      1,
    );
    deprecated.isActive = false;
    vi.mocked(fieldsRepository.findCategoryById).mockResolvedValue(
      category('cat-1', 'COMPUTADORES', null),
    );
    vi.mocked(fieldsRepository.findById)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(deprecated);
    const result = await service.deprecate('cat-1', 'f-1', actor);
    expect(fieldsRepository.deprecate).toHaveBeenCalledWith('f-1');
    expect(result.isActive).toBe(false);
  });
});
