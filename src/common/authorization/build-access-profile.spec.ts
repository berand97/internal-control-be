import { describe, expect, it } from 'vitest';
import { buildAccessProfile } from './build-access-profile.js';
import { DEFAULT_NAVIGATION_ITEMS } from './navigation.defaults.js';

describe('buildAccessProfile', () => {
  it('agrupa acciones por recurso y filtra el menú', () => {
    const profile = buildAccessProfile(
      [
        {
          code: 'campus:read:global',
          module: 'STRUCTURE',
          resourceType: 'campus',
          action: 'read',
          scopeLevel: 'GLOBAL',
        },
      {
        code: 'campus:manage:global',
        module: 'STRUCTURE',
        resourceType: 'campus',
        action: 'manage',
        scopeLevel: 'GLOBAL',
      },
      {
        code: 'user:read:global',
        module: 'USER',
        resourceType: 'user',
        action: 'read',
        scopeLevel: 'GLOBAL',
      },
      ],
      DEFAULT_NAVIGATION_ITEMS,
    );

    expect(profile.permissions).toEqual([
      'campus:manage:global',
      'campus:read:global',
      'user:read:global',
    ]);
    expect(profile.capabilities).toEqual([
      {
        resource: 'campus',
        module: 'STRUCTURE',
        actions: ['manage', 'read'],
        scopes: ['GLOBAL'],
      },
      {
        resource: 'user',
        module: 'USER',
        actions: ['read'],
        scopes: ['GLOBAL'],
      },
    ]);
    expect(profile.navigation.map((item) => item.resource)).toEqual([
      'user',
      'campus',
    ]);
    expect(profile.navigation.map((item) => item.resource)).not.toContain(
      'role',
    );
  });

  it('no publica el catálogo completo cuando el rol solo tiene IAM', () => {
    const profile = buildAccessProfile(
      [
        {
          code: 'user:manage:global',
          module: 'USER',
          resourceType: 'user',
          action: 'manage',
          scopeLevel: 'GLOBAL',
        },
      {
        code: 'role:read:global',
        module: 'USER',
        resourceType: 'role',
        action: 'read',
        scopeLevel: 'GLOBAL',
      },
      {
        code: 'feature:manage:global',
        module: 'SYSTEM',
        resourceType: 'feature',
        action: 'manage',
        scopeLevel: 'GLOBAL',
      },
      {
        code: 'storage:manage:global',
        module: 'SYSTEM',
        resourceType: 'storage',
        action: 'update',
        scopeLevel: 'GLOBAL',
      },
      ],
      DEFAULT_NAVIGATION_ITEMS,
    );

    expect(profile.navigation.map((item) => item.resource)).toEqual([
      'user',
      'role',
      'storage',
      'feature',
    ]);
  });
});
