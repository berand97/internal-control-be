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
  // asset_request:review:global revisa y lee todas las solicitudes (migración 1767225930000).
  'review',
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
