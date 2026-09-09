import { describe, expect, it } from 'vitest';
import { descendantRoleIds } from './role-hierarchy.js';

describe('descendantRoleIds', () => {
  it('devuelve el subárbol de autoridad', () => {
    const roles = [
      { id: 'admin', superiorRoleId: null },
      { id: 'director', superiorRoleId: 'admin' },
      { id: 'auditor', superiorRoleId: 'director' },
      { id: 'viewer', superiorRoleId: 'auditor' },
      { id: 'head', superiorRoleId: 'director' },
    ];
    expect([...descendantRoleIds('director', roles)].sort()).toEqual([
      'auditor',
      'head',
      'viewer',
    ]);
    expect(descendantRoleIds('viewer', roles).size).toBe(0);
  });
});
