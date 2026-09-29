/**
 * Quién no puede operar sin segundo factor: se le fuerza el enrolamiento al entrar y no puede desactivarlo. Lo deciden
 * los PERMISOS efectivos vigentes del usuario (v_user_effective_permissions, con herencia), no el nombre de sus roles:
 * un rol nuevo que reciba cualquiera de estos permisos obliga a sus titulares a usar MFA. La única excepción por nombre
 * es SUPER_ADMIN, el rol raíz de administración.
 *
 * Por qué cada permiso:
 * - act:sign_control:global: firma los turnos de Control Interno (AUDITA, CONTROL_INTERNO), que solo se firman con
 *   sesión con MFA (documents/domain/signing-channel.ts); sin MFA el turno queda bloqueado (SIGNATURE_MFA_REQUIRED).
 * - transfer:sign_accounting:global: firma el acta de traslado por Contabilidad, que mueve activos entre centros.
 * - inventory:reconcile:global: aprueba la conciliación de la toma física, que ajusta el inventario contable.
 * - role:create:global, role:manage:global, role:assign:global, user:manage:global: administración de accesos; quien
 *   los tiene puede darse o dar a otros cualquiera de los permisos de esta lista.
 * - storage:manage:global, mail:manage:global: guardan credenciales del almacenamiento y del correo institucional.
 */
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
  /** Códigos de los roles vigentes del usuario (solo cuenta SUPER_ADMIN). */
  readonly roleCodes: ReadonlyArray<string>;
  /** Códigos de sus permisos efectivos vigentes. */
  readonly permissionCodes: ReadonlyArray<string>;
}

export const requiresMfaEnrollment = (subject: MfaSubject): boolean =>
  subject.roleCodes.includes(MFA_ROOT_ROLE_CODE) ||
  subject.permissionCodes.some((code) => MFA_REQUIRED_PERMISSIONS.includes(code));
