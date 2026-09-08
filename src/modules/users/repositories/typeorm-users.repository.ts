import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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
  ) {}

  findByIdWithPerson(id: string): Promise<AppUser | null> {
    return this.users.findOne({ where: { id }, relations: { person: true } });
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
      .innerJoinAndSelect('u.person', 'p');

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
        `EXISTS (
          SELECT 1 FROM user_role ur
          WHERE ur.user_id = u.id
            AND ur.scope_type = 'COST_CENTER'
            AND ur.scope_id = :costCenterId
            AND ur.revoked_at IS NULL
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
    return this.userRoles.save(
      this.userRoles.create({
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
      }),
    );
  }

  async revokeUserRole(
    id: string,
    revokedBy: string,
    at: Date,
    reason: string | null,
  ): Promise<void> {
    await this.userRoles.update(
      { id },
      {
        revokedAt: at,
        revokedBy,
        revocationReason: reason,
      },
    );
  }
}
