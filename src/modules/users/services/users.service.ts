import { Inject, Injectable } from '@nestjs/common';
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
import { UserStatus } from '../../auth/enums/user-status.enum.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { RefreshTokenFamiliesRepository } from '../../auth/repositories/refresh-token-families.repository.interface.js';
import type { CostCentersRepository } from '../../cost-centers/repositories/cost-centers.repository.interface.js';
import type { OrganizationalUnitsRepository } from '../../organizational-units/repositories/organizational-units.repository.interface.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { AssignUserRoleDto } from '../dto/assign-user-role.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { DelegateUserRoleDto } from '../dto/delegate-user-role.dto.js';
import { QueryUsersDto } from '../dto/query-users.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
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
    const roles = await this.usersRepository.findActiveRoles(user.id);
    return UserDetailResponseDto.fromDetail(user, roles);
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
    const existingDocument = await this.usersRepository.findPersonByDocument(
      dto.documentType,
      dto.documentNumber,
    );
    if (existingDocument) {
      throw new ApiException(ErrorCode.PersonDocumentAlreadyExists);
    }
    const existingEmail = await this.usersRepository.findPersonByEmail(
      dto.email,
    );
    if (existingEmail) {
      throw new ApiException(ErrorCode.PersonEmailAlreadyExists);
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hashService.hash(temporaryPassword);

    try {
      const person = await this.usersRepository.insertPerson({
        documentType: dto.documentType,
        documentNumber: dto.documentNumber,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone ?? null,
        positionTitle: dto.positionTitle ?? null,
      });
      const user = await this.usersRepository.insertUser({
        personId: person.id,
        username,
        passwordHash,
        status: UserStatus.PendingActivation,
        mustChangePassword: true,
      });
      user.person = person;

      await this.mailService.sendUserInvitation(
        dto.email,
        username,
        temporaryPassword,
      );
      await this.auditLogsRepository.record({
        action: AuditAction.UserCreated,
        entityType: USER_ENTITY_TYPE,
        entityId: user.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { username, email: dto.email, invitation: true },
      });
      return UserDetailResponseDto.fromDetail(user, []);
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
    await this.mailService.sendUserInvitation(
      email,
      user.username,
      temporaryPassword,
    );
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
    await this.usersRepository.updatePerson(user.personId, {
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.positionTitle !== undefined
        ? { positionTitle: dto.positionTitle }
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
    return this.getById(id);
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
    await this.requireUser(userId);
    const role = await this.usersRepository.findActiveRole(dto.roleId);
    if (!role) {
      throw new ApiException(ErrorCode.RoleNotFound);
    }
    if (!role.isAssignable) {
      throw new ApiException(ErrorCode.RoleNotAssignable);
    }
    if (role.maxConcurrentUsers !== null) {
      const current = await this.countActiveAssignees(role.id);
      if (current >= role.maxConcurrentUsers) {
        throw new ApiException(ErrorCode.RoleMaxUsersReached);
      }
    }

    const scopeType = dto.scopeType ?? 'GLOBAL';
    const scopeId = dto.scopeId ?? null;
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

  private async requireUser(id: string) {
    const user = await this.usersRepository.findByIdWithPerson(id);
    if (!user) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return user;
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
