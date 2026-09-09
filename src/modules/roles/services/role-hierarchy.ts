export function descendantRoleIds(
  rootId: string,
  roles: ReadonlyArray<{ readonly id: string; readonly superiorRoleId: string | null }>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const role of roles) {
    if (role.superiorRoleId === null) {
      continue;
    }
    const list = children.get(role.superiorRoleId) ?? [];
    list.push(role.id);
    children.set(role.superiorRoleId, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || out.has(id)) {
      continue;
    }
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}
