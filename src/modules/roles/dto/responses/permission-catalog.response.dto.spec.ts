import { describe, expect, it } from 'vitest';

import { Permission } from '../../entities/permission.entity.js';
import { PermissionScopeLevel } from '../../enums/permission-scope-level.enum.js';
import { groupPermissionsCatalog } from './permission-catalog.response.dto.js';

function permission(id: string, resourceType: string, resourceLabel: string): Permission {
  const row = new Permission();
  row.id = id;
  row.code = `${resourceType}:read:global`;
  row.module = 'ASSET';
  row.resourceType = resourceType;
  row.resourceLabel = resourceLabel;
  row.action = 'read';
  row.scopeLevel = PermissionScopeLevel.Global;
  row.description = 'Ver';
  row.isSystem = true;
  return row;
}

describe('groupPermissionsCatalog', () => {
  it('expone la etiqueta en español del recurso, no el código técnico', () => {
    const catalog = groupPermissionsCatalog([
      permission('1', 'asset', 'Activos'),
      permission('2', 'category', 'Categorías'),
    ]);

    expect(catalog[0]?.resources.map((resource) => resource.resourceLabel)).toEqual([
      'Activos',
      'Categorías',
    ]);
    expect(catalog[0]?.resources[0]?.resourceType).toBe('asset');
  });
});
