import { Inject, Injectable } from '@nestjs/common';
import { buildAccessProfile } from '../../../common/authorization/build-access-profile.js';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isSodViolation,
  isUniqueViolation,
} from '../../../common/exceptions/postgres-error.js';
import {
  paginatedResult,
  type PaginatedResult,
} from '../../../common/types/paginated-result.type.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { generateTemporaryPassword } from '../../../shared/crypto/generate-temporary-password.js';
import { HashService } from '../../../shared/crypto/hash.service.js';
import { MailService } from '../../../shared/mail/mail.service.js';
import { AppUser } from '../../auth/entities/app-user.entity.js';
import { Role } from '../../auth/entities/role.entity.js';
import { UserRole } from '../../auth/entities/user-role.entity.js';
import { UserStatus } from '../../auth/enums/user-status.enum.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { AuthUsersRepository } from '../../auth/repositories/auth-users.repository.interface.js';
import type { RefreshTokenFamiliesRepository } from '../../auth/repositories/refresh-token-families.repository.interface.js';
import type { CostCentersRepository } from '../../cost-centers/repositories/cost-centers.repository.interface.js';
import type { OrganizationalUnitsRepository } from '../../organizational-units/repositories/organizational-units.repository.interface.js';
import { NavigationService } from '../../navigation/services/navigation.service.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { RolePrivilegePolicy } from '../../roles/services/role-privilege.policy.js';
import { AssignUserRoleDto } from '../dto/assign-user-role.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { DelegateUserRoleDto } from '../dto/delegate-user-role.dto.js';
import { QueryUsersDto } from '../dto/query-users.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
import { UserAffiliationOptionsResponseDto } from '../dto/responses/user-affiliation-options.response.dto.js';
import { UserDetailResponseDto } from '../dto/responses/user-detail.response.dto.js';
import { UserListItemResponseDto } from '../dto/responses/user-list-item.response.dto.js';
import { UserRoleResponseDto } from '../dto/responses/user-role.response.dto.js';
import {
  ACTIVE_LOANS_PORT,
  type ActiveLoansPort,
} from '../ports/active-loans.port.js';
import type { UsersRepository } from '../repositories/users.repository.interface.js';

const USER_ENTITY_TYPE = 'USER';

@Injectable()
export class UsersService {
  constructor(
    @Inject('UsersRepository')
    private readonly usersRepository: UsersRepository,
    @Inject('AuthUsersRepository')
    private readonly authUsersRepository: AuthUsersRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    @Inject('RefreshTokenFamiliesRepository')
    private readonly refreshTokenFamiliesRepository: RefreshTokenFamiliesRepository,
    @Inject(ACTIVE_LOANS_PORT)
    private readonly activeLoans: ActiveLoansPort,
    private readonly hashService: HashService,
    private readonly mailService: MailService,
    private readonly permissionsService: PermissionsService,
    @Inject('OrganizationalUnitsRepository')
    private readonly organizationalUnitsRepository: OrganizationalUnitsRepository,
    @Inject('CostCentersRepository')
    private readonly costCentersRepository: CostCentersRepository,
    private readonly navigationService: NavigationService,
    private readonly privilege: RolePrivilegePolicy,
  ) {}

  async list(
    query: QueryUsersDto,
  ): Promise<PaginatedResult<UserListItemResponseDto>> {
    const page = query.page;
    const pageSize = query.pageSize;
    const result = await this.usersRepository.list({
      page,
      pageSize,
      ...(query.status ? { status: query.status } : {}),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.costCenterId ? { costCenterId: query.costCenterId } : {}),
    });
    return paginatedResult(
      result.items.map(UserListItemResponseDto.from),
      page,
      pageSize,
      result.totalItems,
    );
  }

  async getById(id: string): Promise<UserDetailResponseDto> {
    const user = await this.requireUser(id);
    return this.toDetail(user);
  }

  async affiliationOptions(
    actor: AuthenticatedUser,
  ): Promise<UserAffiliationOptionsResponseDto> {
    const [units, centers, roles] = await Promise.all([
      this.organizationalUnitsRepository.findAll(true),
      this.costCentersRepository.findAll({ isActive: true }),
      this.privilege.listAssignableFor(actor),
    ]);
    return {
      organizationalUnits: units.map((unit) => ({
        id: unit.id,
        code: unit.code,
        name: unit.name,
        type: unit.unitType,
      })),
      costCenters: centers.map((center) => ({
        id: center.id,
        externalCode: center.externalCode,
        name: center.name,
        organizationalUnitId: center.organizationalUnitId,
      })),
      roles: roles.map((role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
      })),
    };
  }

  async create(
    dto: CreateUserDto,
    actor: AuthenticatedUser,
  ): Promise<UserDetailResponseDto> {
    const username = dto.username ?? dto.email;
    const existingUsername = await this.usersRepository.findByUsername(username);
    if (existingUsername) {
      throw new ApiException(ErrorCode.UsernameAlreadyExists);
    }
    const existingEmail = await this.usersRepository.findPersonByEmail(
      dto.email,
    );
    if (existingEmail) {
      throw new ApiException(ErrorCode.PersonEmailAlreadyExists);
    }

    const affiliation = await this.resolveAffiliation({
      organizationalUnitId: dto.organizationalUnitId ?? null,
      costCenterId: dto.costCenterId ?? null,
    });
    const role = await this.requireAssignableRole(dto.roleId, actor);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hashService.hash(temporaryPassword);

    try {
      const person = await this.usersRepository.insertPerson({
        documentType: null,
        documentNumber: null,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone ?? null,
        positionTitle: dto.positionTitle ?? null,
        organizationalUnitId: affiliation.organizationalUnitId,
        costCenterId: affiliation.costCenterId,
      });
      const user = await this.usersRepository.insertUser({
        personId: person.id,
        username,
        passwordHash,
        status: UserStatus.PendingActivation,
        mustChangePassword: true,
      });
      user.person = person;

      const assignment = await this.insertScopedRole(user, role, actor);
      const invitationSent = await this.mailService.sendUserInvitation(
        dto.email,
        username,
        temporaryPassword,
        {
          roleName: role.name,
          fullName: `${dto.firstName} ${dto.lastName}`.trim(),
        },
      );
      await this.auditLogsRepository.record({
        action: AuditAction.UserCreated,
        entityType: USER_ENTITY_TYPE,
        entityId: user.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: {
          username,
          email: dto.email,
          invitation: invitationSent,
          roleId: role.id,
          organizationalUnitId: affiliation.organizationalUnitId,
          costCenterId: affiliation.costCenterId,
        },
      });
      return UserDetailResponseDto.fromDetail(user, [assignment], [], invitationSent);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.UsernameAlreadyExists);
      }
      throw error;
    }
  }

  async resendInvitation(id: string, actor: AuthenticatedUser): Promise<null> {
    const user = await this.requireUser(id);
    if (user.status === UserStatus.Suspended) {
      throw new ApiException(ErrorCode.UserSuspended);
    }
    if (user.status === UserStatus.Inactive) {
      throw new ApiException(ErrorCode.UserInactive);
    }
    if (
      user.status === UserStatus.Active &&
      user.mustChangePassword !== true
    ) {
      throw new ApiException(ErrorCode.InvalidState);
    }

    const email = user.person?.email;
    if (!email) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hashService.hash(temporaryPassword);
    await this.usersRepository.updateInvitationCredentials(user.id, passwordHash);
    await this.refreshTokenFamiliesRepository.revokeAllForUser(
      user.id,
      new Date(),
    );
    this.permissionsService.invalidate(user.id);
    const activeRoles = await this.usersRepository.findActiveRoles(user.id);
    const invitationSent = await this.mailService.sendUserInvitation(
      email,
      user.username,
      temporaryPassword,
      {
        roleName: activeRoles
          .map((item) => item.role?.name)
          .filter((name): name is string => Boolean(name))
          .join(', '),
        fullName: [user.person?.firstName, user.person?.lastName]
          .filter((part) => Boolean(part))
          .join(' '),
      },
    );
    if (!invitationSent) {
      throw new ApiException(ErrorCode.MailNotConfigured);
    }
    await this.auditLogsRepository.record({
      action: AuditAction.UserInvited,
      entityType: USER_ENTITY_TYPE,
      entityId: user.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { email, username: user.username },
    });
    return null;
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthenticatedUser,
  ): Promise<UserDetailResponseDto> {
    const user = await this.requireUser(id);
    const affiliationPatch =
      dto.organizationalUnitId !== undefined || dto.costCenterId !== undefined
        ? await this.resolveAffiliation({
            organizationalUnitId:
              dto.organizationalUnitId !== undefined
                ? dto.organizationalUnitId
                : (user.person?.organizationalUnitId ?? null),
            costCenterId:
              dto.costCenterId !== undefined
                ? dto.costCenterId
                : (user.person?.costCenterId ?? null),
          })
        : null;
    await this.usersRepository.updatePerson(user.personId, {
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.positionTitle !== undefined
        ? { positionTitle: dto.positionTitle }
        : {}),
      ...(affiliationPatch
        ? {
            organizationalUnitId: affiliationPatch.organizationalUnitId,
            costCenterId: affiliationPatch.costCenterId,
          }
        : {}),
    });
    await this.auditLogsRepository.record({
      action: AuditAction.UserUpdated,
      entityType: USER_ENTITY_TYPE,
      entityId: user.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return this.toDetail(await this.requireUser(id));
  }

  async deactivate(id: string, actor: AuthenticatedUser): Promise<null> {
    const user = await this.requireUser(id);
    const activeLoans = await this.activeLoans.countActiveByResponsibleUserId(
      user.id,
    );
    if (activeLoans > 0) {
      throw new ApiException(ErrorCode.HasActiveLoans);
    }
    const now = new Date();
    await this.usersRepository.updateStatus(user.id, UserStatus.Inactive);
    await this.refreshTokenFamiliesRepository.revokeAllForUser(user.id, now);
    this.permissionsService.invalidate(user.id);
    await this.auditLogsRepository.record({
      action: AuditAction.UserDeactivated,
      entityType: USER_ENTITY_TYPE,
      entityId: user.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
    });
    return null;
  }

  async reactivate(id: string, actor: AuthenticatedUser): Promise<null> {
    const user = await this.requireUser(id);
    await this.usersRepository.updateStatus(user.id, UserStatus.Active);
    this.permissionsService.invalidate(user.id);
    await this.auditLogsRepository.record({
      action: AuditAction.UserReactivated,
      entityType: USER_ENTITY_TYPE,
      entityId: user.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
    });
    return null;
  }

  async assignRole(
    userId: string,
    dto: AssignUserRoleDto,
    actor: AuthenticatedUser,
  ): Promise<UserRoleResponseDto> {
    const user = await this.requireUser(userId);
    const role = await this.requireAssignableRole(dto.roleId, actor);

    const fallback = this.affiliationScope(user);
    const scopeType = dto.scopeType ?? fallback.type;
    const scopeId =
      dto.scopeType !== undefined ? (dto.scopeId ?? null) : fallback.id;
    if (scopeType === 'GLOBAL' && scopeId !== null) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    if (scopeType !== 'GLOBAL' && scopeId === null) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    if (scopeType === 'ORG_UNIT' && scopeId) {
      const unit = await this.organizationalUnitsRepository.findActiveById(
        scopeId,
      );
      if (!unit) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
    }
    if (scopeType === 'COST_CENTER' && scopeId) {
      const center = await this.costCentersRepository.findActiveById(scopeId);
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
    }

    const validFrom = dto.startDate ? new Date(dto.startDate) : new Date();
    const validUntil = dto.endDate ? new Date(dto.endDate) : null;
    if (validUntil && validUntil <= validFrom) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }

    try {
      const assignment = await this.usersRepository.insertUserRole({
        userId,
        roleId: role.id,
        scopeType,
        scopeId,
        validFrom,
        validUntil,
        isDelegated: false,
        delegatedFromUserId: null,
        delegationReason: null,
        grantedBy: actor.id,
      });
      assignment.role = role;
      this.permissionsService.invalidate(userId);
      await this.auditLogsRepository.record({
        action: AuditAction.UserRoleGranted,
        entityType: USER_ENTITY_TYPE,
        entityId: userId,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { roleId: role.id, scopeType, scopeId },
      });
      return UserRoleResponseDto.from(assignment);
    } catch (error) {
      if (isSodViolation(error)) {
        throw new ApiException(ErrorCode.SodViolation);
      }
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      throw error;
    }
  }

  async revokeRole(
    userId: string,
    userRoleId: string,
    actor: AuthenticatedUser,
  ): Promise<null> {
    await this.requireUser(userId);
    const assignment = await this.usersRepository.findUserRoleById(userRoleId);
    if (!assignment || assignment.userId !== userId) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (assignment.revokedAt) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    await this.usersRepository.revokeUserRole(
      assignment.id,
      actor.id,
      new Date(),
      null,
    );
    this.permissionsService.invalidate(userId);
    await this.auditLogsRepository.record({
      action: AuditAction.UserRoleRevoked,
      entityType: USER_ENTITY_TYPE,
      entityId: userId,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { userRoleId },
    });
    return null;
  }

  async delegateRole(
    userId: string,
    userRoleId: string,
    dto: DelegateUserRoleDto,
    actor: AuthenticatedUser,
  ): Promise<UserRoleResponseDto> {
    if (!dto.validUntil) {
      throw new ApiException(ErrorCode.DelegationRequiresExpiry);
    }
    const holder = await this.requireUser(userId);
    const target = await this.requireUser(dto.toUserId);
    const assignment = await this.usersRepository.findUserRoleById(userRoleId);
    if (!assignment || assignment.userId !== holder.id || assignment.revokedAt) {
      throw new ApiException(ErrorCode.CannotDelegateRoleNotHeld);
    }
    const now = new Date();
    if (assignment.validUntil && assignment.validUntil <= now) {
      throw new ApiException(ErrorCode.CannotDelegateRoleNotHeld);
    }
    const validUntil = new Date(dto.validUntil);
    if (validUntil <= now) {
      throw new ApiException(ErrorCode.DelegationRequiresExpiry);
    }

    const role = await this.usersRepository.findActiveRole(assignment.roleId);
    if (!role) {
      throw new ApiException(ErrorCode.RoleNotFound);
    }
    await this.privilege.assertCanAdminister(actor, role);

    try {
      const delegated = await this.usersRepository.insertUserRole({
        userId: target.id,
        roleId: assignment.roleId,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
        validFrom: now,
        validUntil,
        isDelegated: true,
        delegatedFromUserId: holder.id,
        delegationReason: dto.reason ?? null,
        grantedBy: actor.id,
      });
      delegated.role = role;
      this.permissionsService.invalidate(target.id);
      await this.auditLogsRepository.record({
        action: AuditAction.UserRoleDelegated,
        entityType: USER_ENTITY_TYPE,
        entityId: target.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: {
          fromUserId: holder.id,
          userRoleId,
          validUntil: dto.validUntil,
        },
      });
      return UserRoleResponseDto.from(delegated);
    } catch (error) {
      if (isSodViolation(error)) {
        throw new ApiException(ErrorCode.SodViolation);
      }
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      throw error;
    }
  }

  private async requireAssignableRole(
    roleId: string,
    actor: AuthenticatedUser,
  ): Promise<Role> {
    const role = await this.usersRepository.findActiveRole(roleId);
    if (!role) {
      throw new ApiException(ErrorCode.RoleNotFound);
    }
    if (!role.isAssignable) {
      throw new ApiException(ErrorCode.RoleNotAssignable);
    }
    await this.privilege.assertCanAdminister(actor, role);
    if (role.maxConcurrentUsers !== null) {
      const current = await this.countActiveAssignees(role.id);
      if (current >= role.maxConcurrentUsers) {
        throw new ApiException(ErrorCode.RoleMaxUsersReached);
      }
    }
    return role;
  }

  private async insertScopedRole(
    user: AppUser,
    role: Role,
    actor: AuthenticatedUser,
  ): Promise<UserRole> {
    const fallback = this.affiliationScope(user);
    try {
      const assignment = await this.usersRepository.insertUserRole({
        userId: user.id,
        roleId: role.id,
        scopeType: fallback.type,
        scopeId: fallback.id,
        validFrom: new Date(),
        validUntil: null,
        isDelegated: false,
        delegatedFromUserId: null,
        delegationReason: null,
        grantedBy: actor.id,
      });
      assignment.role = role;
      this.permissionsService.invalidate(user.id);
      return assignment;
    } catch (error) {
      if (isSodViolation(error)) {
        throw new ApiException(ErrorCode.SodViolation);
      }
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      throw error;
    }
  }

  private affiliationScope(user: AppUser): {
    readonly type: 'GLOBAL' | 'ORG_UNIT' | 'COST_CENTER';
    readonly id: string | null;
  } {
    const costCenterId = user.person?.costCenterId;
    if (costCenterId) {
      return { type: 'COST_CENTER', id: costCenterId };
    }
    const organizationalUnitId = user.person?.organizationalUnitId;
    if (organizationalUnitId) {
      return { type: 'ORG_UNIT', id: organizationalUnitId };
    }
    return { type: 'GLOBAL', id: null };
  }

  private async resolveAffiliation(input: {
    readonly organizationalUnitId: string | null;
    readonly costCenterId: string | null;
  }): Promise<{
    readonly organizationalUnitId: string | null;
    readonly costCenterId: string | null;
  }> {
    const requestedUnitId = input.organizationalUnitId ?? null;
    const requestedCenterId = input.costCenterId ?? null;
    if (!requestedUnitId && !requestedCenterId) {
      throw new ApiException(ErrorCode.PersonAffiliationRequired);
    }

    let organizationalUnitId = requestedUnitId;
    let costCenterId = requestedCenterId;

    if (requestedCenterId) {
      const center =
        await this.costCentersRepository.findActiveById(requestedCenterId);
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (requestedUnitId && center.organizationalUnitId) {
        if (center.organizationalUnitId !== requestedUnitId) {
          throw new ApiException(ErrorCode.CostCenterOrgUnitMismatch);
        }
      }
      if (!organizationalUnitId) {
        organizationalUnitId = center.organizationalUnitId;
      }
      costCenterId = center.id;
    }

    if (organizationalUnitId) {
      const unit =
        await this.organizationalUnitsRepository.findActiveById(
          organizationalUnitId,
        );
      if (!unit) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      organizationalUnitId = unit.id;
    }

    return { organizationalUnitId, costCenterId };
  }

  private async requireUser(id: string) {
    const user = await this.usersRepository.findByIdWithPerson(id);
    if (!user) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return user;
  }

  private async toDetail(user: AppUser): Promise<UserDetailResponseDto> {
    const [roles, granted, catalog] = await Promise.all([
      this.usersRepository.findActiveRoles(user.id),
      this.authUsersRepository.findEffectivePermissions(user.id),
      this.navigationService.listActiveDefinitions(),
    ]);
    return UserDetailResponseDto.fromDetail(
      user,
      roles,
      buildAccessProfile(granted, catalog).navigation,
    );
  }

  private async countActiveAssignees(roleId: string): Promise<number> {
    const result = await this.usersRepository.list({
      page: 1,
      pageSize: 1,
      roleId,
    });
    return result.totalItems;
  }
}
