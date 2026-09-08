import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { GrantedPermission } from '../../../common/authorization/granted-permission.type.js';
import {
  isTokenScopeType,
  TokenScope,
} from '../../../common/types/authenticated-user.type.js';
import { AppUser } from '../entities/app-user.entity.js';
import { UserRole } from '../entities/user-role.entity.js';
import { UserStatus } from '../enums/user-status.enum.js';
import { AuthUsersRepository } from './auth-users.repository.interface.js';

interface RoleCodeRow {
  readonly code: string;
}

interface ScopeRow {
  readonly scope_type: string;
  readonly scope_id: string | null;
}

const ACTIVE_ROLE_WHERE = `
  ur.revokedAt IS NULL
  AND ur.validFrom <= NOW()
  AND (ur.validUntil IS NULL OR ur.validUntil > NOW())
`;

@Injectable()
export class TypeOrmAuthUsersRepository implements AuthUsersRepository {
  constructor(
    @InjectRepository(AppUser)
    private readonly users: Repository<AppUser>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    private readonly dataSource: DataSource,
  ) {}

  findByUsernameWithPerson(username: string): Promise<AppUser | null> {
    return this.users.findOne({
      where: { username },
      relations: { person: true },
    });
  }

  findByIdWithPerson(id: string): Promise<AppUser | null> {
    return this.users.findOne({ where: { id }, relations: { person: true } });
  }

  findByEmailWithPerson(email: string): Promise<AppUser | null> {
    return this.users
      .createQueryBuilder('u')
      .innerJoinAndSelect('u.person', 'p')
      .where('p.email = :email', { email })
      .getOne();
  }

  async findActiveRoleCodes(userId: string): Promise<ReadonlyArray<string>> {
    const rows = await this.userRoles
      .createQueryBuilder('ur')
      .select('r.code', 'code')
      .innerJoin('ur.role', 'r')
      .where('ur.userId = :userId', { userId })
      .andWhere(ACTIVE_ROLE_WHERE)
      .distinct(true)
      .getRawMany<RoleCodeRow>();
    return rows.map((row): string => row.code);
  }

  async findActiveScopes(userId: string): Promise<ReadonlyArray<TokenScope>> {
    const rows = await this.userRoles
      .createQueryBuilder('ur')
      .select('ur.scopeType', 'scope_type')
      .addSelect('ur.scopeId', 'scope_id')
      .where('ur.userId = :userId', { userId })
      .andWhere(ACTIVE_ROLE_WHERE)
      .distinct(true)
      .getRawMany<ScopeRow>();
    return rows.flatMap((row): ReadonlyArray<TokenScope> => {
      const scopeType: unknown = row.scope_type;
      if (!isTokenScopeType(scopeType)) {
        return [];
      }
      return [{ type: scopeType, id: row.scope_id }];
    });
  }

  async markLoggedIn(userId: string, at: Date): Promise<void> {
    await this.users.update({ id: userId }, { lastLoginAt: at });
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.users.update(
      { id: userId },
      { passwordHash, mustChangePassword: false },
    );
  }

  async activateAfterPasswordReset(userId: string): Promise<void> {
    await this.users.update(
      { id: userId, status: UserStatus.PendingActivation },
      { status: UserStatus.Active, mustChangePassword: false },
    );
  }

  async findEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<GrantedPermission>> {
    const rows = await this.dataSource.query<
      ReadonlyArray<{
        permission_code: string;
        module: string;
        resource_type: string;
        action: string;
        scope_level: string;
      }>
    >(
      `
      SELECT DISTINCT permission_code, module, resource_type, action, scope_level
      FROM v_user_effective_permissions
      WHERE user_id = $1
      ORDER BY permission_code
      `,
      [userId],
    );
    return rows.map((row) => ({
      code: row.permission_code,
      module: row.module,
      resourceType: row.resource_type,
      action: row.action,
      scopeLevel: row.scope_level,
    }));
  }

  async saveMfaSecret(userId: string, secret: string): Promise<void> {
    await this.users.update({ id: userId }, { mfaSecret: secret });
  }

  async enableMfa(userId: string): Promise<void> {
    await this.users.update({ id: userId }, { mfaEnabled: true });
  }
}
