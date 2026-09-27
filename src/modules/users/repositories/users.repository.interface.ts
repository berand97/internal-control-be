import type { AppUser } from '../../auth/entities/app-user.entity.js';
import type { Person } from '../../auth/entities/person.entity.js';
import type { Role } from '../../auth/entities/role.entity.js';
import type { UserRole } from '../../auth/entities/user-role.entity.js';
import type { UserStatus } from '../../auth/enums/user-status.enum.js';

export interface CreatePersonRecord {
  readonly documentType: string | null;
  readonly documentNumber: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly positionTitle: string | null;
  readonly organizationalUnitId: string | null;
  readonly costCenterId: string | null;
}

export interface CreateAppUserRecord {
  readonly personId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
  readonly mustChangePassword: boolean;
  /** Vencimiento de la contraseña temporal de la invitación (BE-14). */
  readonly invitationExpiresAt: Date | null;
}

export interface UpdatePersonRecord {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string | null;
  readonly positionTitle?: string | null;
  readonly organizationalUnitId?: string | null;
  readonly costCenterId?: string | null;
}

export interface ListUsersQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: UserStatus;
  readonly roleId?: string;
  readonly costCenterId?: string;
}

export interface CreateUserRoleRecord {
  readonly userId: string;
  readonly roleId: string;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly isDelegated: boolean;
  readonly delegatedFromUserId: string | null;
  readonly delegationReason: string | null;
  readonly grantedBy: string;
}

export interface UsersRepository {
  findByIdWithPerson(id: string): Promise<AppUser | null>;
  findByUsername(username: string): Promise<AppUser | null>;
  findPersonByEmail(email: string): Promise<Person | null>;
  findPersonByDocument(
    documentType: string,
    documentNumber: string,
  ): Promise<Person | null>;
  list(query: ListUsersQuery): Promise<{
    readonly items: ReadonlyArray<AppUser>;
    readonly totalItems: number;
  }>;
  insertPerson(record: CreatePersonRecord): Promise<Person>;
  insertUser(record: CreateAppUserRecord): Promise<AppUser>;
  updatePerson(personId: string, record: UpdatePersonRecord): Promise<void>;
  updateStatus(userId: string, status: UserStatus): Promise<void>;
  updateInvitationCredentials(
    userId: string,
    passwordHash: string,
    invitationExpiresAt: Date,
  ): Promise<void>;
  findActiveRoles(userId: string): Promise<ReadonlyArray<UserRole>>;
  findUserRoleById(id: string): Promise<UserRole | null>;
  findActiveRole(id: string): Promise<Role | null>;
  insertUserRole(record: CreateUserRoleRecord): Promise<UserRole>;
  /**
   * Inserta la asignación respetando el cupo del rol (max_concurrent_users) en una transacción con el rol bloqueado
   * (FOR UPDATE): dos asignaciones o delegaciones concurrentes no superan el cupo. Cuenta usuarios distintos con una
   * asignación vigente del rol, sin contar al propio destinatario. Lanza ROLE_MAX_USERS_REACHED si no hay cupo.
   */
  insertUserRoleWithinLimit(
    record: CreateUserRoleRecord,
    maxConcurrentUsers: number | null,
  ): Promise<UserRole>;
  /**
   * Revoca la asignación y, en la misma transacción, en cascada las delegaciones hechas desde ella (y las delegadas
   * desde esas): mismo rol y alcance, delegated_from_user_id = titular de la asignación revocada. Devuelve los
   * usuarios cuyas asignaciones se revocaron (el titular incluido) para invalidar cachés.
   */
  revokeUserRoleCascade(
    id: string,
    revokedBy: string,
    at: Date,
    reason: string | null,
  ): Promise<ReadonlyArray<string>>;
}
