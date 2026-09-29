import type { GrantedPermission } from '../../../common/authorization/granted-permission.type.js';
import type { TokenScope } from '../../../common/types/authenticated-user.type.js';
import type { AppUser } from '../entities/app-user.entity.js';

/** Rol activo del usuario: código (estable) y nombre editable por el administrador. */
export interface ActiveRole {
  readonly code: string;
  readonly name: string;
}

export interface AuthUsersRepository {
  findByUsernameWithPerson(username: string): Promise<AppUser | null>;
  findByEmailWithPerson(email: string): Promise<AppUser | null>;
  findByIdWithPerson(id: string): Promise<AppUser | null>;
  findActiveRoleCodes(userId: string): Promise<ReadonlyArray<string>>;
  findActiveRoles(userId: string): Promise<ReadonlyArray<ActiveRole>>;
  findActiveScopes(userId: string): Promise<ReadonlyArray<TokenScope>>;
  markLoggedIn(userId: string, at: Date): Promise<void>;
  updatePassword(userId: string, passwordHash: string): Promise<void>;
  activateAfterPasswordReset(userId: string): Promise<void>;
  findEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<GrantedPermission>>;
  saveMfaSecret(userId: string, secret: string): Promise<void>;
  enableMfa(userId: string): Promise<void>;
}
