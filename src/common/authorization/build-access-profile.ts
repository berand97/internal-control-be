import { actionSatisfies } from './action-satisfies.js';
import type { NavigationDefinition } from './navigation.registry.js';
import type {
  GrantedPermission,
  NavigationItem,
  ResourceCapability,
} from './granted-permission.type.js';

export interface AccessProfile {
  readonly permissions: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<ResourceCapability>;
  readonly navigation: ReadonlyArray<NavigationItem>;
}

export const buildAccessProfile = (
  granted: ReadonlyArray<GrantedPermission>,
  catalog: ReadonlyArray<NavigationDefinition> = [],
): AccessProfile => {
  const byResource = new Map<
    string,
    {
      module: string;
      actions: Set<string>;
      scopes: Set<string>;
    }
  >();

  for (const permission of granted) {
    const current = byResource.get(permission.resourceType) ?? {
      module: permission.module,
      actions: new Set<string>(),
      scopes: new Set<string>(),
    };
    current.actions.add(permission.action);
    current.scopes.add(permission.scopeLevel);
    byResource.set(permission.resourceType, current);
  }

  const capabilities = [...byResource.entries()]
    .map(([resource, value]) => ({
      resource,
      module: value.module,
      actions: [...value.actions].sort(),
      scopes: [...value.scopes].sort(),
    }))
    .sort((left, right) => left.resource.localeCompare(right.resource));

  const can = (resource: string, action: string): boolean => {
    const granted = byResource.get(resource);
    return granted ? actionSatisfies(granted.actions, action) : false;
  };

  const navigation = catalog
    .filter((item) => can(item.resource, item.requiredAction))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((item) => ({
      module: item.module,
      moduleLabel: item.moduleLabel,
      resource: item.resource,
      path: item.path,
      label: item.label,
    }));

  return {
    permissions: [...new Set(granted.map((item) => item.code))].sort(),
    capabilities,
    navigation,
  };
};
