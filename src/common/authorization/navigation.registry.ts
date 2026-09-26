import type { NavigationIcon } from './navigation-icons.js';

export interface NavigationDefinition {
  readonly module: string;
  readonly moduleLabel: string;
  readonly resource: string;
  readonly path: string;
  readonly label: string;
  readonly requiredAction: string;
  readonly sortOrder: number;
  readonly icon: NavigationIcon | null;
}
