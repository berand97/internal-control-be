import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Role } from '../../auth/entities/role.entity.js';
import { UserRole } from '../../auth/entities/user-role.entity.js';
import { Permission } from '../entities/permission.entity.js';
import { RolePermission } from '../entities/role-permission.entity.js';
import { RoleSeparationOfDuties } from '../entities/role-separation-of-duties.entity.js';
import type {
  CreateRoleRecord,
  RolesRepository,
  UpdateRoleRecord,
} from './roles.repository.interface.js';

@Injectable()
export class TypeOrmRolesRepository implements RolesRepository {
  constructor(
    @InjectRepository(Role)
    private readonly roles: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(RoleSeparationOfDuties)
    private readonly sodRules: Repository<RoleSeparationOfDuties>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
  ) {}

  findAllActive(): Promise<ReadonlyArray<Role>> {
    return this.roles.find({
      where: { deletedAt: IsNull() },
      order: { hierarchyLevel: 'ASC', name: 'ASC' },
    });
  }

  findActiveById(id: string): Promise<Role | null> {
    return this.roles.findOne({ where: { id, deletedAt: IsNull() } });
  }

  findActiveByCode(code: string): Promise<Role | null> {
    return this.roles.findOne({ where: { code, deletedAt: IsNull() } });
  }

  findChildren(parentRoleId: string): Promise<ReadonlyArray<Role>> {
    return this.roles.find({
      where: { parentRoleId, deletedAt: IsNull() },
      order: { name: 'ASC' },
    });
  }

  async insert(record: CreateRoleRecord): Promise<Role> {
    const now = new Date();
    const entity = this.roles.create({
      code: record.code,
      name: record.name,
      description: record.description,
      parentRoleId: record.parentRoleId,
      hierarchyLevel: record.hierarchyLevel,
      isSystem: record.isSystem,
      isAssignable: record.isAssignable,
      maxConcurrentUsers: record.maxConcurrentUsers,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    return this.roles.save(entity);
  }

  async update(id: string, record: UpdateRoleRecord): Promise<void> {
    await this.roles.update({ id }, record);
  }

  async softDelete(id: string, at: Date): Promise<void> {
    await this.roles.update({ id }, { deletedAt: at });
  }

  listPermissions(): Promise<ReadonlyArray<Permission>> {
    return this.permissions.find({ order: { module: 'ASC', code: 'ASC' } });
  }

  findPermissionsByIds(
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<Permission>> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.permissions.find({ where: { id: In([...ids]) } });
  }

  async findPermissionsForRole(
    roleId: string,
  ): Promise<ReadonlyArray<Permission>> {
    const rows = await this.rolePermissions.find({
      where: { roleId },
      relations: { permission: true },
    });
    return rows.flatMap((row): ReadonlyArray<Permission> => {
      return row.permission ? [row.permission] : [];
    });
  }

  async assignPermission(
    roleId: string,
    permissionId: string,
    grantedBy: string,
  ): Promise<RolePermission> {
    const existing = await this.rolePermissions.findOne({
      where: { roleId, permissionId },
    });
    if (existing) {
      return existing;
    }
    return this.rolePermissions.save(
      this.rolePermissions.create({
        roleId,
        permissionId,
        grantedBy,
        conditions: null,
        grantedAt: new Date(),
      }),
    );
  }

  async replacePermissions(
    roleId: string,
    permissionIds: ReadonlyArray<string>,
    grantedBy: string,
  ): Promise<void> {
    await this.rolePermissions.manager.transaction(async (manager) => {
      const repo = manager.getRepository(RolePermission);
      const current = await repo.find({ where: { roleId } });
      const nextIds = new Set(permissionIds);
      const currentIds = new Set(current.map((row) => row.permissionId));
      const toRemove = current
        .map((row) => row.permissionId)
        .filter((id) => !nextIds.has(id));
      if (toRemove.length > 0) {
        await repo.delete({ roleId, permissionId: In(toRemove) });
      }
      const grantedAt = new Date();
      const toAdd = [...nextIds].filter((id) => !currentIds.has(id));
      if (toAdd.length > 0) {
        await repo.save(
          toAdd.map((permissionId) =>
            repo.create({
              roleId,
              permissionId,
              grantedBy,
              conditions: null,
              grantedAt,
            }),
          ),
        );
      }
    });
  }

  async removePermission(
    roleId: string,
    permissionId: string,
  ): Promise<boolean> {
    const result = await this.rolePermissions.delete({ roleId, permissionId });
    return (result.affected ?? 0) > 0;
  }

  findSodForRole(
    roleId: string,
  ): Promise<ReadonlyArray<RoleSeparationOfDuties>> {
    return this.sodRules.find({
      where: [{ roleAId: roleId }, { roleBId: roleId }],
    });
  }

  insertSod(record: {
    readonly roleAId: string;
    readonly roleBId: string;
    readonly constraintType: RoleSeparationOfDuties['constraintType'];
    readonly reason: string;
  }): Promise<RoleSeparationOfDuties> {
    const entity = this.sodRules.create();
    entity.roleAId = record.roleAId;
    entity.roleBId = record.roleBId;
    entity.constraintType = record.constraintType;
    entity.reason = record.reason;
    entity.createdAt = new Date();
    return this.sodRules.save(entity);
  }

  async findActiveAssigneeIds(roleId: string): Promise<ReadonlyArray<string>> {
    const rows = await this.userRoles
      .createQueryBuilder('ur')
      .select('ur.userId', 'userId')
      .where('ur.roleId = :roleId', { roleId })
      .andWhere('ur.revokedAt IS NULL')
      .distinct(true)
      .getRawMany<{ userId: string }>();
    return rows.map((row) => row.userId);
  }

  countActiveAssignees(roleId: string): Promise<number> {
    return this.userRoles
      .createQueryBuilder('ur')
      .where('ur.roleId = :roleId', { roleId })
      .andWhere('ur.revokedAt IS NULL')
      .getCount();
  }
}
