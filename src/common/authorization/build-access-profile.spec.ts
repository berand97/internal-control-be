import { describe, expect, it } from 'vitest';
import { buildAccessProfile } from './build-access-profile.js';

describe('buildAccessProfile', () => {
  it('agrupa acciones por recurso y filtra el menú', () => {
    const profile = buildAccessProfile([
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
    ]);

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
});
