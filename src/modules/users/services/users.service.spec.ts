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
  let permissionsService: Pick<PermissionsService, 'invalidate'>;
  let service: UsersService;

  beforeEach(() => {
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
      findActiveRole: vi.fn(),
      insertUserRole: vi.fn(),
      revokeUserRole: vi.fn(),
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
    mailService = { sendUserInvitation: vi.fn().mockResolvedValue(undefined) };
    permissionsService = { invalidate: vi.fn() };
    service = new UsersService(
      usersRepository,
      auditLogsRepository,
      refreshTokenFamiliesRepository,
      activeLoans,
      hashService as never,
      mailService as never,
      permissionsService as PermissionsService,
      {
        findActiveById: vi.fn().mockResolvedValue({ id: 'ou-1' }),
      } as never,
      {
        findActiveById: vi.fn().mockResolvedValue({ id: 'cc-1' }),
      } as never,
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
  });

  it('rechaza asignar un rol no asignable', async () => {
    const role = buildRole();
    role.isAssignable = false;
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
    await expect(
      service.assignRole('user-1', { roleId: role.id }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.RoleNotAssignable });
  });

  it('exige vencimiento al delegar', async () => {
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    await expect(
      service.delegateRole(
        'user-1',
        'ur-1',
        { toUserId: 'user-2', validUntil: '' },
        actor,
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
        { toUserId: 'user-2', validUntil: future },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CannotDelegateRoleNotHeld });
  });

  it('crea usuario pendiente, usa el correo como usuario y envía invitación', async () => {
    const created = buildUser('user-new');
    created.status = UserStatus.PendingActivation;
    created.mustChangePassword = true;
    created.username = 'ana.ruiz@unac.edu.co';
    vi.mocked(usersRepository.insertPerson).mockResolvedValue(created.person!);
    vi.mocked(usersRepository.insertUser).mockResolvedValue(created);
    const result = await service.create(
      {
        documentType: 'CC',
        documentNumber: '123',
        firstName: 'Ana',
        lastName: 'Ruiz',
        email: 'ana.ruiz@unac.edu.co',
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
      }),
    );
    expect(mailService.sendUserInvitation).toHaveBeenCalledWith(
      'ana.ruiz@unac.edu.co',
      'ana.ruiz@unac.edu.co',
      expect.stringMatching(PASSWORD_POLICY_REGEX),
    );
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
    );
    expect(refreshTokenFamiliesRepository.revokeAllForUser).toHaveBeenCalled();
    expect(mailService.sendUserInvitation).toHaveBeenCalledWith(
      'ana.ruiz@unac.edu.co',
      'ana.ruiz',
      expect.stringMatching(PASSWORD_POLICY_REGEX),
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
          documentType: 'CC',
          documentNumber: '123',
          firstName: 'Ana',
          lastName: 'Ruiz',
          email: 'ana.ruiz@unac.edu.co',
          username: 'ana.ruiz',
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
    vi.mocked(usersRepository.insertUserRole).mockResolvedValue(assignment);
    const result = await service.assignRole(
      'user-1',
      { roleId: role.id },
      actor,
    );
    expect(result.roleCode).toBe('VIEWER');
    expect(permissionsService.invalidate).toHaveBeenCalledWith('user-1');
  });

  it('rechaza asignación que viola SoD', async () => {
    const role = buildRole();
    vi.mocked(usersRepository.findByIdWithPerson).mockResolvedValue(
      buildUser('user-1'),
    );
    vi.mocked(usersRepository.findActiveRole).mockResolvedValue(role);
    vi.mocked(usersRepository.insertUserRole).mockRejectedValue(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('Violación de Separación de Funciones'), {
          code: 'P0001',
        }),
      ),
    );
    await expect(
      service.assignRole('user-1', { roleId: role.id }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.SodViolation });
  });
});
