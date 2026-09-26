import type { NavigationIcon } from './navigation-icons.js';

export interface GrantedPermission {
  readonly code: string;
  readonly module: string;
  readonly resourceType: string;
  readonly action: string;
  readonly scopeLevel: string;
}

export interface ResourceCapability {
  readonly resource: string;
  readonly module: string;
  readonly actions: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
}

export interface NavigationItem {
  readonly module: string;
  readonly moduleLabel: string;
  readonly resource: string;
  readonly path: string;
  readonly label: string;
  readonly icon: NavigationIcon | null;
}
