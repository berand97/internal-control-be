import { describe, expect, it } from 'vitest';
import { buildAccessProfile } from './build-access-profile.js';
import { applyFeatureFlags } from './apply-feature-flags.js';

const granted = [
  {
    code: 'loan:read:global',
    module: 'ASSET',
    resourceType: 'loan',
    action: 'read',
    scopeLevel: 'GLOBAL',
  },
  {
    code: 'asset:read:global',
    module: 'ASSET',
    resourceType: 'asset',
    action: 'read',
    scopeLevel: 'GLOBAL',
  },
] as const;

const snapshot = (
  enabled: boolean,
  resourceTypes: ReadonlyArray<string>,
): { enabled: boolean; resourceTypes: ReadonlyArray<string> } => ({
  enabled,
  resourceTypes,
});

describe('applyFeatureFlags', () => {
  it('oculta navegación y capabilities del módulo apagado', () => {
    const profile = applyFeatureFlags(buildAccessProfile([...granted]), [
      snapshot(false, ['loan']),
      snapshot(true, ['asset']),
    ]);

    expect(profile.navigation.map((item) => item.resource)).toEqual(['asset']);
    expect(profile.capabilities.map((item) => item.resource)).toEqual(['asset']);
    expect(profile.permissions).toEqual([
      'asset:read:global',
      'loan:read:global',
    ]);
  });

  it('no altera el perfil si todos los módulos están activos', () => {
    const original = buildAccessProfile([...granted]);
    const profile = applyFeatureFlags(original, [
      snapshot(true, ['loan']),
      snapshot(true, ['asset']),
    ]);
    expect(profile).toEqual(original);
  });
});
