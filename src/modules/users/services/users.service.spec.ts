import { QueryFailedError } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { PASSWORD_POLICY_REGEX } from '../../../common/validation/password.constants.js';
import { AppUser } from '../../auth/entities/app-user.entity.js';
import { Person } from '../../auth/entities/person.entity.js';
import { Role } from '../../auth/entities/role.entity.js';
import { UserRole } from '../../auth/entities/user-role.entity.js';
import { UserStatus } from '../../auth/enums/user-status.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { RefreshTokenFamiliesRepository } from '../../auth/repositories/refresh-token-families.repository.interface.js';
import type { PermissionsService } from '../../roles/services/permissions.service.js';
import type { ActiveLoansPort } from '../ports/active-loans.port.js';
import type { UsersRepository } from '../repositories/users.repository.interface.js';
import { UsersService } from './users.service.js';

const ORIGIN = { ipAddress: null, userAgent: null };

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-admin',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const buildUser = (id: string): AppUser => {
  const person = new Person();
  person.id = `person-${id}`;
  person.firstName = 'Ana';
  person.lastName = 'Ruiz';
  person.email = 'ana.ruiz@unac.edu.co';
  person.documentType = 'CC';
  person.documentNumber = '1';
  person.phone = null;
  person.positionTitle = null;
  const user = new AppUser();
  user.id = id;
  user.personId = person.id;
  user.person = person;
  user.username = 'ana.ruiz';
  user.status = UserStatus.Active;
  user.mfaEnabled = false;
  user.mustChangePassword = false;
  return user;
};

const buildRole = (): Role => {
  const role = new Role();
  role.id = 'role-viewer';
  role.code = 'VIEWER';
  role.name = 'Consulta';
  role.isAssignable = true;
  role.maxConcurrentUsers = null;
  role.deletedAt = null;
  return role;
};

describe('UsersService', () => {
  let usersRepository: UsersRepository;
  let auditLogsRepository: AuditLogsRepository;
  let refreshTokenFamiliesRepository: RefreshTokenFamiliesRepository;
  let activeLoans: ActiveLoansPort;
  let hashService: { hash: ReturnType<typeof vi.fn> };
  let mailService: { sendUserInvitation: ReturnType<typeof vi.fn> };
  let permissionsService: Pick<PermissionsService, 'invalidate' | 'invalidateMany'>;
  let authUsersRepository: { findEffectivePermissions: ReturnType<typeof vi.fn> };
  let privilege: {
    assertCanAdminister: ReturnType<typeof vi.fn>;
    assertCanAdministerUser: ReturnType<typeof vi.fn>;
    listAssignableFor: ReturnType<typeof vi.fn>;
  };
  let sessions: { invalidate: ReturnType<typeof vi.fn> };
  let mfaAccount: { resetByAdmin: ReturnType<typeof vi.fn> };
  let service: UsersService;

  beforeEach(() => {
    const insertAssignment = async (record: {
      userId: string;
      roleId: string;
      scopeType: string;
      scopeId: string | null;
      validFrom: Date;
      validUntil: Date | null;
      isDelegated: boolean;
      delegatedFromUserId: string | null;
    }) => {
      const assignment = new UserRole();
      assignment.id = 'ur-new';
      assignment.userId = record.userId;
      assignment.roleId = record.roleId;
      assignment.scopeType = record.scopeType;
      assignment.scopeId = record.scopeId;
      assignment.validFrom = record.validFrom;
      assignment.validUntil = record.validUntil;
      assignment.isDelegated = record.isDelegated;
      assignment.delegatedFromUserId = record.delegatedFromUserId;
      return assignment;
    };
    usersRepository = {
      findByIdWithPerson: vi.fn(),
      findByUsername: vi.fn().mockResolvedValue(null),
      findPersonByEmail: vi.fn().mockResolvedValue(null),
      findPersonByDocument: vi.fn().mockResolvedValue(null),
      list: vi.fn(),
      insertPerson: vi.fn(),
      insertUser: vi.fn(),
      updatePerson: vi.fn(),
      updateStatus: vi.fn(),
      updateInvitationCredentials: vi.fn(),
      findActiveRoles: vi.fn().mockResolvedValue([]),
      findUserRoleById: vi.fn(),
      findActiveRole: vi.fn().mockResolvedValue(buildRole()),
      insertUserRole: vi.fn(insertAssignment),
      insertUserRoleWithinLimit: vi.fn(insertAssignment),
      revokeUserRoleCascade: vi.fn().mockResolvedValue(['user-1']),
    };
    auditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    refreshTokenFamiliesRepository = {
      findById: vi.fn(),
      insert: vi.fn(),
      rotate: vi.fn(),
      revoke: vi.fn(),
      revokeAllForUser: vi.fn().mockResolvedValue(1),
    };
    activeLoans = {
      countActiveByResponsibleUserId: vi.fn().mockResolvedValue(0),
    };
    hashService = { hash: vi.fn().mockResolvedValue('hashed') };
    mailService = { sendUserInvitation: vi.fn().mockResolvedValue(true) };
    permissionsService = { invalidate: vi.fn(), invalidateMany: vi.fn() };
    sessions = { invalidate: vi.fn() };
    mfaAccount = {
      resetByAdmin: vi.fn().mockResolvedValue({
        userId: 'user-1',
        revokedSessions: 1,
        recoveryCodesDeleted: 0,
      }),
    };
    authUsersRepository = {
      findEffectivePermissions: vi.fn().mockResolvedValue([]),
    };
    privilege = {
      assertCanAdminister: vi.fn().mockResolvedValue(undefined),
      assertCanAdministerUser: vi.fn().mockResolvedValue(undefined),
      listAssignableFor: vi.fn().mockResolvedValue([]),
    };
    service = new UsersService(
      usersRepository,
      authUsersRepository as never,
      auditLogsRepository,
      refreshTokenFamiliesRepository,
      activeLoans,
      hashService as never,
      mailService as never,
      permissionsService as PermissionsService,
      {
        findActiveById: vi.fn().mockResolvedValue({ id: 'ou-1' }),
        findAll: vi.fn().mockResolvedValue([]),
      } as never,
      {
        findActiveById: vi
          .fn()
          .mockResolvedValue({ id: 'cc-1', organizationalUnitId: 'ou-1' }),
        findAll: vi.fn().mockResolvedValue([]),
      } as never,
      {
        listActiveDefinitions: vi.fn().mockResolvedValue([]),
      } as never,
      privilege as never,
      sessions as never,
      mfaAccount as never,
    );
  });

  it('rechaza desactivar un usuario con préstamos activos', async () => {
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(activeLoans.countActiveByResponsibleUserId).mockResolvedValue(2);
    await expect(service.deactivate('user-1', actor)).rejects.toMatchObject({
      code: ErrorCode.HasActiveLoans,
    });
  });

  it('revoca sesiones al desactivar', async () => {
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    await service.deactivate('user-1', actor);
    expect(refreshTokenFamiliesRepository.revokeAllForUser).toHaveBeenCalled();
    expect(permissionsService.invalidate).toHaveBeenCalledWith('user-1');
    expect(sessions.invalidate).toHaveBeenCalledWith('user-1');
  });

  describe('BE-07: rango sobre el usuario objetivo', () => {
    const escalation = () =>
      Object.assign(new Error('escalation'), {
        code: ErrorCode.RolePrivilegeEscalation,
      });

    beforeEach(() => {
      vi.mocked(usersRepository.findByIdWithPerson).mockImplementation(
        async (id: string) => buildUser(id),
      );
      privilege.assertCanAdministerUser.mockRejectedValue(escalation());
    });

    it('desactivar a alguien de rango igual o superior se rechaza sin tocar su estado', async () => {
      await expect(service.deactivate('user-1', actor)).rejects.toMatchObject({
        code: ErrorCode.RolePrivilegeEscalation,
      });
      expect(usersRepository.updateStatus).not.toHaveBeenCalled();
      expect(privilege.assertCanAdministerUser).toHaveBeenCalledWith(actor, 'user-1');
    });

    it('reactivar, revocar un rol, editar, reenviar la invitación y restablecer el MFA también', async () => {
      const suspended = buildUser('user-1');
      suspended.status = UserStatus.Suspended;
      vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(suspended);
      const assignment = new UserRole();
      assignment.id = 'ur-1';
      assignment.userId = 'user-1';
      assignment.revokedAt = null;
      vi.mocked(usersRepository.findUserRoleById).mockResolvedValue(assignment);
      const calls = [
        service.reactivate('user-1', actor),
        service.revokeRole('user-1', 'ur-1', { reason: 'Motivo de prueba' }, actor, ORIGIN),
        service.update('user-1', { firstName: 'Otra' }, actor),
        service.resendInvitation('user-1', actor),
        service.resetMfa('user-1', 'Perdió el teléfono', actor, {
          ipAddress: null,
          userAgent: null,
        }),
      ];
      for (const call of calls) {
        await expect(call).rejects.toMatchObject({
          code: ErrorCode.RolePrivilegeEscalation,
        });
      }
      expect(usersRepository.updateStatus).not.toHaveBeenCalled();
      expect(usersRepository.revokeUserRoleCascade).not.toHaveBeenCalled();
      expect(usersRepository.updatePerson).not.toHaveBeenCalled();
      expect(usersRepository.updateInvitationCredentials).not.toHaveBeenCalled();
      expect(mfaAccount.resetByAdmin).not.toHaveBeenCalled();
    });

    it('con rango suficiente, restablecer el MFA delega en MfaAccountService', async () => {
      privilege.assertCanAdministerUser.mockResolvedValue(undefined);
      const context = { ipAddress: null, userAgent: null };
      await service.resetMfa('user-1', 'Perdió el teléfono', actor, context);
      expect(mfaAccount.resetByAdmin).toHaveBeenCalledWith(
        actor,
        'user-1',
        'Perdió el teléfono',
        context,
      );
    });
  });

  describe('reactivar', () => {
    it('devuelve a ACTIVE una cuenta suspendida o inactiva e invalida la caché de sesión', async () => {
      for (const status of [UserStatus.Suspended, UserStatus.Inactive]) {
        const user = buildUser('user-1');
        user.status = status;
        vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(user);
        await service.reactivate('user-1', actor);
      }
      expect(usersRepository.updateStatus).toHaveBeenCalledTimes(2);
      expect(usersRepository.updateStatus).toHaveBeenCalledWith(
        'user-1',
        UserStatus.Active,
      );
      expect(sessions.invalidate).toHaveBeenCalledWith('user-1');
    });

    it('rechaza una cuenta ACTIVE o pendiente de activación', async () => {
      for (const status of [UserStatus.Active, UserStatus.PendingActivation]) {
        const user = buildUser('user-1');
        user.status = status;
        vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(user);
        await expect(service.reactivate('user-1', actor)).rejects.toMatchObject({
          code: ErrorCode.InvalidState,
        });
      }
      expect(usersRepository.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('BE-08: delegación', () => {
    const future = (ms: number) => new Date(Date.now() + ms);
    const source = (validUntil: Date | null) => {
      const assignment = new UserRole();
      assignment.id = 'ur-1';
      assignment.userId = 'user-1';
      assignment.roleId = 'role-viewer';
      assignment.scopeType = 'GLOBAL';
      assignment.scopeId = null;
      assignment.validFrom = new Date(Date.now() - 60_000);
      assignment.validUntil = validUntil;
      assignment.revokedAt = null;
      return assignment;
    };

    beforeEach(() => {
      vi.mocked(usersRepository.findByIdWithPerson).mockImplementation(
        async (id: string) => buildUser(id),
      );
    });

    it('no puede durar más que la asignación de origen', async () => {
      vi.mocked(usersRepository.findUserRoleById).mockResolvedValue(
        source(future(86_400_000)),
      );
      await expect(
        service.delegateRole(
          'user-1',
          'ur-1',
          { reason: 'Motivo de prueba', toUserId: 'user-2', validUntil: future(2 * 86_400_000).toISOString() },
          actor,
          ORIGIN,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.DelegationExceedsSourceValidity });
      expect(usersRepository.insertUserRoleWithinLimit).not.toHaveBeenCalled();
    });

    it('respeta isAssignable', async () => {
      const role = buildRole();
      role.isAssignable = false;
      vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
      vi.mocked(usersRepository.findUserRoleById).mockResolvedValue(source(null));
      await expect(
        service.delegateRole(
          'user-1',
          'ur-1',
          { reason: 'Motivo de prueba', toUserId: 'user-2', validUntil: future(86_400_000).toISOString() },
          actor,
          ORIGIN,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.RoleNotAssignable });
    });

    it('no se delega al propio titular', async () => {
      await expect(
        service.delegateRole(
          'user-1',
          'ur-1',
          { reason: 'Motivo de prueba', toUserId: 'user-1', validUntil: future(86_400_000).toISOString() },
          actor,
          ORIGIN,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidState });
    });

    it('inserta con el cupo del rol y marca la delegación', async () => {
      const role = buildRole();
      role.maxConcurrentUsers = 3;
      vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
      vi.mocked(usersRepository.list).mockResolvedValue({ items: [], totalItems: 1 });
      vi.mocked(usersRepository.findUserRoleById).mockResolvedValue(
        source(future(2 * 86_400_000)),
      );
      await service.delegateRole(
        'user-1',
        'ur-1',
        { reason: 'Motivo de prueba', toUserId: 'user-2', validUntil: future(86_400_000).toISOString() },
        actor,
        ORIGIN,
      );
      expect(usersRepository.insertUserRoleWithinLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-2',
          isDelegated: true,
          delegatedFromUserId: 'user-1',
        }),
        3,
      );
    });

    it('revocar el origen revoca en cascada e invalida los permisos de todos los afectados', async () => {
      vi.mocked(usersRepository.findUserRoleById).mockResolvedValue(source(null));
      vi.mocked(usersRepository.revokeUserRoleCascade).mockResolvedValue([
        'user-1',
        'user-2',
      ]);
      await service.revokeRole('user-1', 'ur-1', { reason: 'Motivo de prueba' }, actor, ORIGIN);
      expect(usersRepository.revokeUserRoleCascade).toHaveBeenCalledWith(
        'ur-1',
        actor.id,
        expect.any(Date),
        'Motivo de prueba',
      );
      expect(permissionsService.invalidateMany).toHaveBeenCalledWith(
        expect.arrayContaining(['user-1', 'user-2']),
      );
    });
  });

  it('rechaza asignar un rol no asignable', async () => {
    const role = buildRole();
    role.isAssignable = false;
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
    await expect(
      service.assignRole('user-1', { reason: 'Motivo de prueba', roleId: role.id }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.RoleNotAssignable });
  });

  it('nadie se asigna un rol a sí mismo, tampoco SUPER_ADMIN', async () => {
    await expect(
      service.assignRole(actor.id, { reason: 'Motivo de prueba', roleId: 'role-x' }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.RoleSelfAssignmentForbidden });
    expect(usersRepository.insertUserRoleWithinLimit).not.toHaveBeenCalled();
  });

  it('nadie se delega a sí mismo el rol de otro', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await expect(
      service.delegateRole(
        'user-1',
        'ur-1',
        { reason: 'Motivo de prueba', toUserId: actor.id, validUntil: future },
        actor,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RoleSelfAssignmentForbidden });
    expect(usersRepository.insertUserRoleWithinLimit).not.toHaveBeenCalled();
  });

  it('exige vencimiento al delegar', async () => {
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    await expect(
      service.delegateRole(
        'user-1',
        'ur-1',
        { reason: 'Motivo de prueba', toUserId: 'user-2', validUntil: '' },
        actor,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.DelegationRequiresExpiry });
  });

  it('rechaza delegar un rol que el origen no posee', async () => {
    vi.mocked(usersRepository.findByIdWithPerson).mockImplementation(
      async (id: string) => buildUser(id),
    );
    vi.mocked(usersRepository.findUserRoleById).mockResolvedValue(null);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await expect(
      service.delegateRole(
        'user-1',
        'ur-1',
        { reason: 'Motivo de prueba', toUserId: 'user-2', validUntil: future },
        actor,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CannotDelegateRoleNotHeld });
  });

  it('crea usuario pendiente, usa el correo como usuario y envía invitación', async () => {
    const created = buildUser('user-new');
    created.status = UserStatus.PendingActivation;
    created.mustChangePassword = true;
    created.username = 'ana.ruiz@unac.edu.co';
    created.person!.organizationalUnitId = 'ou-1';
    vi.mocked(usersRepository.insertPerson).mockResolvedValue(created.person!);
    vi.mocked(usersRepository.insertUser).mockResolvedValue(created);
    const result = await service.create(
      {
        firstName: 'Ana',
        lastName: 'Ruiz',
        email: 'ana.ruiz@unac.edu.co',
        organizationalUnitId: 'ou-1',
        roleId: 'role-viewer',
      },
      actor,
    );
    expect(result.status).toBe(UserStatus.PendingActivation);
    expect(result.username).toBe('ana.ruiz@unac.edu.co');
    expect(result.mustChangePassword).toBe(true);
    expect(usersRepository.insertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'ana.ruiz@unac.edu.co',
        status: UserStatus.PendingActivation,
        mustChangePassword: true,
        invitationExpiresAt: expect.any(Date),
      }),
    );
    expect(usersRepository.insertUserRoleWithinLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: 'role-viewer',
        scopeType: 'ORG_UNIT',
        scopeId: 'ou-1',
      }),
      null,
    );
    expect(mailService.sendUserInvitation).toHaveBeenCalledWith(
      'ana.ruiz@unac.edu.co',
      'ana.ruiz@unac.edu.co',
      expect.stringMatching(PASSWORD_POLICY_REGEX),
      expect.objectContaining({
        roleName: 'Consulta',
        fullName: 'Ana Ruiz',
      }),
    );
    expect(usersRepository.insertPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: null,
        documentNumber: null,
        organizationalUnitId: 'ou-1',
        costCenterId: null,
      }),
    );
    expect(result.invitationSent).toBe(true);
  });

  it('exige departamento o centro de costo al crear', async () => {
    await expect(
      service.create(
        {
          firstName: 'Ana',
          lastName: 'Ruiz',
          email: 'ana.ruiz@unac.edu.co',
          roleId: 'role-viewer',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PersonAffiliationRequired });
  });

  it('rechaza un centro de costo de otro departamento', async () => {
    await expect(
      service.create(
        {
          firstName: 'Ana',
          lastName: 'Ruiz',
          email: 'ana.ruiz@unac.edu.co',
          organizationalUnitId: 'ou-2',
          costCenterId: 'cc-1',
          roleId: 'role-viewer',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CostCenterOrgUnitMismatch });
  });

  it('reenvía invitación y rota la contraseña temporal', async () => {
    const pending = buildUser('user-1');
    pending.status = UserStatus.PendingActivation;
    pending.mustChangePassword = true;
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(pending);
    await service.resendInvitation('user-1', actor);
    expect(usersRepository.updateInvitationCredentials).toHaveBeenCalledWith(
      'user-1',
      'hashed',
      expect.any(Date),
    );
    // BE-14: el reenvío renueva el plazo de 72 h.
    const expiresAt = vi.mocked(usersRepository.updateInvitationCredentials).mock
      .calls[0]?.[2] as Date;
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(72 * 3_600_000);
    expect(refreshTokenFamiliesRepository.revokeAllForUser).toHaveBeenCalled();
    expect(mailService.sendUserInvitation).toHaveBeenCalledWith(
      'ana.ruiz@unac.edu.co',
      'ana.ruiz',
      expect.stringMatching(PASSWORD_POLICY_REGEX),
      expect.objectContaining({ fullName: 'Ana Ruiz' }),
    );
  });

  it('rechaza reenviar invitación a un usuario ya activo', async () => {
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    await expect(
      service.resendInvitation('user-1', actor),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidState });
  });

  it('rechaza username duplicado', async () => {
    vi.mocked(usersRepository.findByUsername).mockResolvedValue(
      buildUser('other'),
    );
    await expect(
      service.create(
        {
          firstName: 'Ana',
          lastName: 'Ruiz',
          email: 'ana.ruiz@unac.edu.co',
          username: 'ana.ruiz',
          roleId: 'role-viewer',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UsernameAlreadyExists });
  });

  it('asigna un rol global', async () => {
    const role = buildRole();
    const assignment = new UserRole();
    assignment.id = 'ur-1';
    assignment.userId = 'user-1';
    assignment.roleId = role.id;
    assignment.role = role;
    assignment.scopeType = 'GLOBAL';
    assignment.scopeId = null;
    assignment.validFrom = new Date();
    assignment.validUntil = null;
    assignment.isDelegated = false;
    assignment.delegatedFromUserId = null;
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
    vi.mocked(usersRepository.insertUserRoleWithinLimit).mockResolvedValue(assignment);
    const result = await service.assignRole(
      'user-1',
      { reason: 'Motivo de prueba', roleId: role.id },
      actor,
      ORIGIN,
    );
    expect(result.roleCode).toBe('VIEWER');
    expect(privilege.assertCanAdminister).toHaveBeenCalled();
    expect(permissionsService.invalidate).toHaveBeenCalledWith('user-1');
  });

  it('no asigna un rol igual o superior al del actor', async () => {
    const role = buildRole();
    role.code = 'SUPER_ADMIN';
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
    privilege.assertCanAdminister.mockRejectedValue(
      Object.assign(new Error('escalation'), {
        code: ErrorCode.RolePrivilegeEscalation,
      }),
    );
    await expect(
      service.assignRole('user-1', { reason: 'Motivo de prueba', roleId: role.id }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.RolePrivilegeEscalation });
    expect(usersRepository.insertUserRoleWithinLimit).not.toHaveBeenCalled();
  });

  it('rechaza asignación que viola SoD', async () => {
    const role = buildRole();
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
    vi.mocked(usersRepository.insertUserRoleWithinLimit).mockRejectedValue(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('Violación de Separación de Funciones'), {
          code: 'P0001',
        }),
      ),
    );
    await expect(
      service.assignRole('user-1', { reason: 'Motivo de prueba', roleId: role.id }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.SodViolation });
  });
});
