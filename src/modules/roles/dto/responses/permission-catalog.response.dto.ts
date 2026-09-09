import { ApiProperty } from '@nestjs/swagger';
import type { Permission } from '../../entities/permission.entity.js';
import { PermissionResponseDto } from './permission.response.dto.js';

export class PermissionCatalogResourceDto {
  @ApiProperty()
  readonly resourceType!: string;

  @ApiProperty({ example: 'Activos' })
  readonly resourceLabel!: string;

  @ApiProperty({ type: [PermissionResponseDto] })
  readonly permissions!: ReadonlyArray<PermissionResponseDto>;
}

export class PermissionCatalogModuleDto {
  @ApiProperty({ example: 'STRUCTURE' })
  readonly module!: string;

  @ApiProperty({ type: [PermissionCatalogResourceDto] })
  readonly resources!: ReadonlyArray<PermissionCatalogResourceDto>;
}

export const groupPermissionsCatalog = (
  permissions: ReadonlyArray<Permission>,
): ReadonlyArray<PermissionCatalogModuleDto> => {
  const modules = new Map<string, Map<string, Permission[]>>();
  for (const permission of permissions) {
    const resources = modules.get(permission.module) ?? new Map();
    const items = resources.get(permission.resourceType) ?? [];
    items.push(permission);
    resources.set(permission.resourceType, items);
    modules.set(permission.module, resources);
  }

  return [...modules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([module, resources]) => ({
      module,
      resources: [...resources.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([resourceType, items]) => ({
          resourceType,
          resourceLabel: items[0]?.resourceLabel ?? resourceType,
          permissions: items
            .map(PermissionResponseDto.from)
            .sort((left, right) => left.code.localeCompare(right.code)),
        })),
    }));
};
