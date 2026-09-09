const ACTIONS_THAT_SATISFY_READ = new Set([
  'read',
  'manage',
  'create',
  'update',
  'delete',
  'assign',
  'approve',
  'export',
  'sign',
]);

export const actionSatisfies = (
  grantedActions: ReadonlySet<string>,
  requiredAction: string,
): boolean => {
  if (grantedActions.has(requiredAction)) {
    return true;
  }
  if (requiredAction !== 'read') {
    return false;
  }
  for (const action of grantedActions) {
    if (ACTIONS_THAT_SATISFY_READ.has(action)) {
      return true;
    }
  }
  return false;
};
