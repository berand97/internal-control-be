import type { AppUser } from '../../auth/entities/app-user.entity.js';
import type { Person } from '../../auth/entities/person.entity.js';
import type { Role } from '../../auth/entities/role.entity.js';
import type { UserRole } from '../../auth/entities/user-role.entity.js';
import type { UserStatus } from '../../auth/enums/user-status.enum.js';

export interface CreatePersonRecord {
  readonly documentType: string;
  readonly documentNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly positionTitle: string | null;
}

export interface CreateAppUserRecord {
  readonly personId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
  readonly mustChangePassword: boolean;
}

export interface UpdatePersonRecord {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string | null;
  readonly positionTitle?: string | null;
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
  ): Promise<void>;
  findActiveRoles(userId: string): Promise<ReadonlyArray<UserRole>>;
  findUserRoleById(id: string): Promise<UserRole | null>;
  findActiveRole(id: string): Promise<Role | null>;
  insertUserRole(record: CreateUserRoleRecord): Promise<UserRole>;
  revokeUserRole(
    id: string,
    revokedBy: string,
    at: Date,
    reason: string | null,
  ): Promise<void>;
}
