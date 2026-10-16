export const MFA_ROOT_ROLE_CODE = 'SUPER_ADMIN';

export const MFA_REQUIRED_PERMISSIONS: ReadonlyArray<string> = [
  'act:sign_control:global',
  'transfer:sign_accounting:global',
  'inventory:reconcile:global',
  'role:create:global',
  'role:manage:global',
  'role:assign:global',
  'user:manage:global',
  'storage:manage:global',
  'mail:manage:global',
];

export interface MfaSubject {
  readonly roleCodes: ReadonlyArray<string>;
  readonly permissionCodes: ReadonlyArray<string>;
}

export const requiresMfaEnrollment = (subject: MfaSubject): boolean =>
  subject.roleCodes.includes(MFA_ROOT_ROLE_CODE) ||
  subject.permissionCodes.some((code) => MFA_REQUIRED_PERMISSIONS.includes(code));
