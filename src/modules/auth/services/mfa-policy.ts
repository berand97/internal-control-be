/** Roles que no pueden operar sin segundo factor: se les fuerza el enrolamiento y no pueden desactivarlo. */
export const MFA_REQUIRED_ROLE_CODES = [
  'SUPER_ADMIN',
  'INTERNAL_CONTROL_DIRECTOR',
] as const;

export const requiresMfaEnrollment = (
  roleCodes: ReadonlyArray<string>,
): boolean =>
  roleCodes.some((code) =>
    (MFA_REQUIRED_ROLE_CODES as ReadonlyArray<string>).includes(code),
  );
