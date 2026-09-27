import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { AppUser } from '../../auth/entities/app-user.entity.js';
import { Person } from '../../auth/entities/person.entity.js';
import { Role } from '../../auth/entities/role.entity.js';
import { UserRole } from '../../auth/entities/user-role.entity.js';
import type { UserStatus } from '../../auth/enums/user-status.enum.js';
import type {
  CreateAppUserRecord,
  CreatePersonRecord,
  CreateUserRoleRecord,
  ListUsersQuery,
  UpdatePersonRecord,
  UsersRepository,
} from './users.repository.interface.js';

@Injectable()
export class TypeOrmUsersRepository implements UsersRepository {
  constructor(
    @InjectRepository(AppUser)
    private readonly users: Repository<AppUser>,
    @InjectRepository(Person)
    private readonly persons: Repository<Person>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    private readonly dataSource: DataSource,
  ) {}

  findByIdWithPerson(id: string): Promise<AppUser | null> {
    return this.users.findOne({
      where: { id },
      relations: { person: { organizationalUnit: true, costCenter: true } },
    });
  }

  findByUsername(username: string): Promise<AppUser | null> {
    return this.users.findOne({ where: { username } });
  }

  findPersonByEmail(email: string): Promise<Person | null> {
    return this.persons.findOne({ where: { email } });
  }

  findPersonByDocument(
    documentType: string,
    documentNumber: string,
  ): Promise<Person | null> {
    return this.persons.findOne({ where: { documentType, documentNumber } });
  }

  async list(query: ListUsersQuery): Promise<{
    readonly items: ReadonlyArray<AppUser>;
    readonly totalItems: number;
  }> {
    const builder = this.users
      .createQueryBuilder('u')
      .innerJoinAndSelect('u.person', 'p')
      .leftJoinAndSelect('p.organizationalUnit', 'ou')
      .leftJoinAndSelect('p.costCenter', 'cc');

    if (query.status) {
      builder.andWhere('u.status = :status', { status: query.status });
    }
    if (query.roleId) {
      builder.andWhere(
        `EXISTS (
          SELECT 1 FROM user_role ur
          WHERE ur.user_id = u.id
            AND ur.role_id = :roleId
            AND ur.revoked_at IS NULL
        )`,
        { roleId: query.roleId },
      );
    }
    if (query.costCenterId) {
      builder.andWhere(
        `(
          p.cost_center_id = :costCenterId
          OR EXISTS (
            SELECT 1 FROM user_role ur
            WHERE ur.user_id = u.id
              AND ur.scope_type = 'COST_CENTER'
              AND ur.scope_id = :costCenterId
              AND ur.revoked_at IS NULL
          )
        )`,
        { costCenterId: query.costCenterId },
      );
    }

    builder.orderBy('p.last_name', 'ASC').addOrderBy('p.first_name', 'ASC');
    builder.skip((query.page - 1) * query.pageSize).take(query.pageSize);

    const [items, totalItems] = await builder.getManyAndCount();
    return { items, totalItems };
  }

  insertPerson(record: CreatePersonRecord): Promise<Person> {
    const now = new Date();
    return this.persons.save(
      this.persons.create({
        ...record,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  insertUser(record: CreateAppUserRecord): Promise<AppUser> {
    const now = new Date();
    return this.users.save(
      this.users.create({
        ...record,
        mfaEnabled: false,
        mfaSecret: null,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async updatePerson(
    personId: string,
    record: UpdatePersonRecord,
  ): Promise<void> {
    await this.persons.update({ id: personId }, record);
  }

  async updateStatus(userId: string, status: UserStatus): Promise<void> {
    await this.users.update({ id: userId }, { status });
  }

  async updateInvitationCredentials(
    userId: string,
    passwordHash: string,
    invitationExpiresAt: Date,
  ): Promise<void> {
    await this.users.update(
      { id: userId },
      { passwordHash, mustChangePassword: true, invitationExpiresAt },
    );
  }

  findActiveRoles(userId: string): Promise<ReadonlyArray<UserRole>> {
    return this.userRoles.find({
      where: { userId, revokedAt: IsNull() },
      relations: { role: true },
      order: { grantedAt: 'DESC' },
    });
  }

  findUserRoleById(id: string): Promise<UserRole | null> {
    return this.userRoles.findOne({
      where: { id },
      relations: { role: true },
    });
  }

  findActiveRole(id: string): Promise<Role | null> {
    return this.roles.findOne({ where: { id, deletedAt: IsNull() } });
  }

  insertUserRole(record: CreateUserRoleRecord): Promise<UserRole> {
    return this.userRoles.save(this.newUserRole(record));
  }

  insertUserRoleWithinLimit(
    record: CreateUserRoleRecord,
    maxConcurrentUsers: number | null,
  ): Promise<UserRole> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM role WHERE id = $1 FOR UPDATE', [
        record.roleId,
      ]);
      if (maxConcurrentUsers !== null) {
        const [row] = (await manager.query(
          `SELECT count(DISTINCT ur.user_id)::int AS holders
           FROM user_role ur
           WHERE ur.role_id = $1
             AND ur.user_id <> $2
             AND ur.revoked_at IS NULL
             AND ur.valid_from <= NOW()
             AND (ur.valid_until IS NULL OR ur.valid_until > NOW())`,
          [record.roleId, record.userId],
        )) as Array<{ holders: number }>;
        if ((row?.holders ?? 0) >= maxConcurrentUsers) {
          throw new ApiException(ErrorCode.RoleMaxUsersReached);
        }
      }
      return manager.getRepository(UserRole).save(this.newUserRole(record));
    });
  }

  async revokeUserRoleCascade(
    id: string,
    revokedBy: string,
    at: Date,
    reason: string | null,
  ): Promise<ReadonlyArray<string>> {
    return this.dataSource.transaction(async (manager) => {
      const affected = new Set<string>();
      let frontier = (await manager.query(
        `UPDATE user_role SET revoked_at = $2, revoked_by = $3, revocation_reason = $4
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, user_id`,
        [id, at, revokedBy, reason],
      )) as [Array<{ id: string; user_id: string }>, number];
      // Cada vuelta revoca las delegaciones hechas desde las asignaciones recién revocadas (cadenas incluidas).
      while (frontier[0].length > 0) {
        for (const row of frontier[0]) {
          affected.add(row.user_id);
        }
        frontier = (await manager.query(
          `UPDATE user_role d
           SET revoked_at = $2, revoked_by = $3, revocation_reason = $4
           FROM user_role src
           WHERE src.id = ANY($1::uuid[])
             AND d.is_delegated
             AND d.delegated_from_user_id = src.user_id
             AND d.role_id = src.role_id
             AND d.scope_type = src.scope_type
             AND d.scope_id IS NOT DISTINCT FROM src.scope_id
             AND d.revoked_at IS NULL
           RETURNING d.id, d.user_id`,
          [
            frontier[0].map((row) => row.id),
            at,
            revokedBy,
            'Revocada en cascada: se revocó la asignación de origen de la delegación',
          ],
        )) as [Array<{ id: string; user_id: string }>, number];
      }
      return [...affected];
    });
  }

  private newUserRole(record: CreateUserRoleRecord): UserRole {
    return this.userRoles.create({
        userId: record.userId,
        roleId: record.roleId,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
        validFrom: record.validFrom,
        validUntil: record.validUntil,
        isDelegated: record.isDelegated,
        delegatedFromUserId: record.delegatedFromUserId,
        delegationReason: record.delegationReason,
        grantedBy: record.grantedBy,
        grantedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
      });
  }

}
