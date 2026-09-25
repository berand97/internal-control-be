import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { HashService } from '../../../shared/crypto/hash.service.js';
import type { MfaProofDto } from '../dto/mfa-proof.dto.js';
import type { VerifyMfaDto } from '../dto/verify-mfa.dto.js';
import { MfaPendingEnrollmentResponseDto } from '../dto/responses/mfa-pending-enrollment.response.dto.js';
import { MfaEnrollmentResponseDto } from '../dto/responses/mfa-enrollment.response.dto.js';
import { MfaDisabledResponseDto } from '../dto/responses/mfa-disabled.response.dto.js';
import { MfaRecoveryCodesResponseDto } from '../dto/responses/mfa-recovery-codes.response.dto.js';
import type { AppUser } from '../entities/app-user.entity.js';
import { AuditAction } from '../enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../repositories/audit-logs.repository.interface.js';
import type { AuthUsersRepository } from '../repositories/auth-users.repository.interface.js';
import type { MfaCredentialsRepository } from '../repositories/mfa-credentials.repository.interface.js';
import { requiresMfaEnrollment } from './mfa-policy.js';
import { MfaService } from './mfa.service.js';
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from './recovery-codes.js';
import { TokenService } from './token.service.js';

export interface MfaRequestContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export type MfaProofMethod = 'TOTP' | 'RECOVERY_CODE';

export interface MfaStatus {
  readonly recoveryCodesRemaining: number;
  readonly requiredByRole: boolean;
  readonly sessionVerified: boolean;
}

export interface AdminMfaResetOutcome {
  readonly userId: string;
  readonly revokedSessions: number;
  readonly recoveryCodesDeleted: number;
}

/** Vida del secreto pendiente: tiempo para escanear el QR y teclear el primer código. */
export const MFA_PENDING_TTL_MS = 15 * 60 * 1000;
const USER_ENTITY_TYPE = 'USER';

/**
 * Ciclo de vida del segundo factor fuera del login: enrolar o re-enrolar desde sesión, códigos de recuperación,
 * desactivar y reset administrativo. Nunca escribe secretos ni códigos en audit_log ni en mensajes de error.
 */
@Injectable()
export class MfaAccountService {
  constructor(
    @Inject('AuthUsersRepository')
    private readonly authUsersRepository: AuthUsersRepository,
    @Inject('MfaCredentialsRepository')
    private readonly credentials: MfaCredentialsRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly mfaService: MfaService,
    private readonly hashService: HashService,
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
  ) {}

  async status(
    actor: AuthenticatedUser,
    user: AppUser,
    roles: ReadonlyArray<string>,
  ): Promise<MfaStatus> {
    const [recoveryCodesRemaining, sessionVerified] = await Promise.all([
      user.mfaEnabled
        ? this.credentials.countUnusedRecoveryCodes(user.id)
        : Promise.resolve(0),
      this.isMfaSession(actor),
    ]);
    return {
      recoveryCodesRemaining,
      requiredByRole: requiresMfaEnrollment(roles),
      sessionVerified,
    };
  }

  /**
   * True si la sesión del token (claim sid) sigue activa, se abrió o elevó con segundo factor y el usuario tiene MFA
   * activo. Es la definición de "sesión con MFA" para acciones sensibles.
   */
  async isMfaSession(actor: AuthenticatedUser): Promise<boolean> {
    if (!actor.sessionId) {
      return false;
    }
    return this.credentials.isMfaSession(actor.id, actor.sessionId);
  }

  async assertMfaSession(actor: AuthenticatedUser): Promise<void> {
    if (!(await this.isMfaSession(actor))) {
      throw new ApiException(ErrorCode.MfaSessionRequired);
    }
  }

  async startEnrollment(
    actor: AuthenticatedUser,
    proof: MfaProofDto,
    context: MfaRequestContext,
  ): Promise<MfaPendingEnrollmentResponseDto> {
    const user = await this.requireUser(actor.id);
    const method = user.mfaEnabled
      ? await this.assertProof(user, proof, context, 'REENROLL')
      : null;
    const enrollment = await this.mfaService.createEnrollment(
      user.person?.email ?? user.username,
      this.tokenService.getIssuer(),
    );
    const now = new Date();
    await this.credentials.savePending(user.id, enrollment.secret, now);
    await this.audit(AuditAction.MfaEnrollmentStarted, user.id, actor.id, context, {
      reenroll: user.mfaEnabled,
      proof: method,
    });
    return MfaPendingEnrollmentResponseDto.fromPending(
      MfaEnrollmentResponseDto.from(
        enrollment.secret,
        enrollment.otpauthUrl,
        enrollment.qrDataUrl,
      ),
      new Date(now.getTime() + MFA_PENDING_TTL_MS),
    );
  }

  async confirmEnrollment(
    actor: AuthenticatedUser,
    dto: VerifyMfaDto,
    context: MfaRequestContext,
  ): Promise<MfaRecoveryCodesResponseDto> {
    const user = await this.requireUser(actor.id);
    const pending = await this.credentials.findPending(user.id);
    if (!pending || isExpired(pending.createdAt)) {
      throw new ApiException(ErrorCode.MfaEnrollmentNotStarted);
    }
    if (!(await this.mfaService.verifyTotp(dto.code, pending.secret))) {
      await this.audit(AuditAction.MfaVerificationFailed, user.id, actor.id, context, {
        purpose: 'CONFIRM_ENROLLMENT',
      });
      throw new ApiException(ErrorCode.MfaVerificationFailed);
    }
    const codes = generateRecoveryCodes();
    const hashes = await this.hashCodes(codes);
    const reenroll = user.mfaEnabled;
    await this.dataSource.transaction(async (manager) => {
      await this.credentials.lockUser(user.id, manager);
      const current = await this.credentials.findPending(user.id, manager);
      if (current?.secret !== pending.secret) {
        // Otro inicio de enrolamiento reemplazó el secreto entre la verificación y el bloqueo.
        throw new ApiException(ErrorCode.MfaEnrollmentNotStarted);
      }
      await this.credentials.activate(user.id, pending.secret, manager);
      await this.credentials.replaceRecoveryCodes(user.id, hashes, manager);
      const now = new Date();
      const revokedSessions = reenroll
        ? await this.credentials.revokeSessions(
            user.id,
            actor.sessionId ?? null,
            now,
            manager,
          )
        : 0;
      if (actor.sessionId) {
        await this.credentials.markSessionMfaVerified(
          user.id,
          actor.sessionId,
          now,
          manager,
        );
      }
      await this.audit(
        reenroll ? AuditAction.MfaReenrolled : AuditAction.MfaEnabled,
        user.id,
        actor.id,
        context,
        {
          source: 'SESSION',
          recoveryCodesIssued: codes.length,
          revokedSessions,
        },
        manager,
      );
    });
    return MfaRecoveryCodesResponseDto.from(codes);
  }

  /**
   * Cierre del enrolamiento obligatorio (token de setup): activa el secreto ya guardado, emite los códigos y limpia
   * la marca de enrolamiento pendiente, todo en una transacción.
   */
  async completeSetupEnrollment(
    user: AppUser,
    secret: string,
    context: MfaRequestContext,
  ): Promise<ReadonlyArray<string>> {
    const codes = generateRecoveryCodes();
    const hashes = await this.hashCodes(codes);
    await this.dataSource.transaction(async (manager) => {
      await this.credentials.lockUser(user.id, manager);
      await this.credentials.activate(user.id, secret, manager);
      await this.credentials.replaceRecoveryCodes(user.id, hashes, manager);
      await this.audit(
        AuditAction.MfaEnabled,
        user.id,
        user.id,
        context,
        { source: 'SETUP', recoveryCodesIssued: codes.length },
        manager,
      );
    });
    return codes;
  }

  async regenerateRecoveryCodes(
    actor: AuthenticatedUser,
    context: MfaRequestContext,
  ): Promise<MfaRecoveryCodesResponseDto> {
    const user = await this.requireUser(actor.id);
    if (!user.mfaEnabled) {
      throw new ApiException(ErrorCode.MfaNotEnabled);
    }
    await this.assertMfaSession(actor);
    const codes = generateRecoveryCodes();
    const hashes = await this.hashCodes(codes);
    await this.dataSource.transaction(async (manager) => {
      await this.credentials.lockUser(user.id, manager);
      await this.credentials.replaceRecoveryCodes(user.id, hashes, manager);
      await this.audit(
        AuditAction.MfaRecoveryCodesRegenerated,
        user.id,
        actor.id,
        context,
        { recoveryCodesIssued: codes.length },
        manager,
      );
    });
    return MfaRecoveryCodesResponseDto.from(codes);
  }

  /**
   * Solo para quien no tiene un rol que exija MFA. Un firmante de Control Interno con rol que lo exige nunca pasa;
   * cualquier otro que desactive MFA deja de cumplir la condición de sesión con MFA y no podrá firmar.
   */
  async disable(
    actor: AuthenticatedUser,
    proof: MfaProofDto,
    context: MfaRequestContext,
  ): Promise<MfaDisabledResponseDto> {
    const user = await this.requireUser(actor.id);
    if (!user.mfaEnabled) {
      throw new ApiException(ErrorCode.MfaNotEnabled);
    }
    const roles = await this.authUsersRepository.findActiveRoleCodes(user.id);
    if (requiresMfaEnrollment(roles)) {
      throw new ApiException(ErrorCode.MfaRequiredByRole);
    }
    const method = await this.assertProof(user, proof, context, 'DISABLE');
    return this.dataSource.transaction(async (manager) => {
      await this.credentials.lockUser(user.id, manager);
      await this.credentials.clear(user.id, false, manager);
      const recoveryCodesDeleted = await this.credentials.deleteRecoveryCodes(
        user.id,
        manager,
      );
      const revokedSessions = await this.credentials.revokeSessions(
        user.id,
        actor.sessionId ?? null,
        new Date(),
        manager,
      );
      await this.audit(
        AuditAction.MfaDisabled,
        user.id,
        actor.id,
        context,
        { proof: method, recoveryCodesDeleted, revokedSessions },
        manager,
      );
      return { revokedSessions, recoveryCodesDeleted };
    });
  }

  async resetByAdmin(
    actor: AuthenticatedUser,
    targetUserId: string,
    reason: string,
    context: MfaRequestContext,
  ): Promise<AdminMfaResetOutcome> {
    if (actor.id === targetUserId) {
      throw new ApiException(ErrorCode.MfaSelfResetForbidden);
    }
    await this.assertMfaSession(actor);
    const target = await this.authUsersRepository.findByIdWithPerson(
      targetUserId,
    );
    if (!target) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.dataSource.transaction(async (manager) => {
      await this.credentials.lockUser(target.id, manager);
      await this.credentials.clear(target.id, true, manager);
      const recoveryCodesDeleted = await this.credentials.deleteRecoveryCodes(
        target.id,
        manager,
      );
      const revokedSessions = await this.credentials.revokeSessions(
        target.id,
        null,
        new Date(),
        manager,
      );
      await this.audit(
        AuditAction.MfaResetByAdmin,
        target.id,
        actor.id,
        context,
        {
          reason: reason.trim(),
          hadMfa: target.mfaEnabled,
          recoveryCodesDeleted,
          revokedSessions,
        },
        manager,
      );
      return { userId: target.id, revokedSessions, recoveryCodesDeleted };
    });
  }

  /**
   * Consume un código de recuperación en el paso de desafío del login. Devuelve los restantes o null si no coincide
   * ninguno (o ya estaba usado).
   */
  async consumeForLogin(
    user: AppUser,
    rawCode: string,
    context: MfaRequestContext,
  ): Promise<number | null> {
    if (!(await this.consumeMatching(user.id, rawCode))) {
      return null;
    }
    const remaining = await this.credentials.countUnusedRecoveryCodes(user.id);
    await this.audit(AuditAction.MfaRecoveryCodeUsed, user.id, user.id, context, {
      purpose: 'LOGIN',
      recoveryCodesRemaining: remaining,
    });
    return remaining;
  }

  private async assertProof(
    user: AppUser,
    proof: MfaProofDto,
    context: MfaRequestContext,
    purpose: 'REENROLL' | 'DISABLE',
  ): Promise<MfaProofMethod> {
    if (
      proof.code !== undefined &&
      user.mfaSecret &&
      (await this.mfaService.verifyTotp(proof.code, user.mfaSecret))
    ) {
      return 'TOTP';
    }
    if (
      proof.recoveryCode !== undefined &&
      (await this.consumeMatching(user.id, proof.recoveryCode))
    ) {
      await this.audit(AuditAction.MfaRecoveryCodeUsed, user.id, user.id, context, {
        purpose,
        recoveryCodesRemaining: await this.credentials.countUnusedRecoveryCodes(
          user.id,
        ),
      });
      return 'RECOVERY_CODE';
    }
    await this.audit(AuditAction.MfaVerificationFailed, user.id, user.id, context, {
      purpose,
    });
    throw new ApiException(ErrorCode.MfaVerificationFailed);
  }

  private async consumeMatching(
    userId: string,
    rawCode: string,
  ): Promise<boolean> {
    const canonical = normalizeRecoveryCode(rawCode);
    if (canonical === null) {
      await this.hashService.runDummyVerification(rawCode);
      return false;
    }
    const stored = await this.credentials.findUnusedRecoveryCodes(userId);
    for (const candidate of stored) {
      if (await this.hashService.verify(candidate.codeHash, canonical)) {
        return this.credentials.consumeRecoveryCode(candidate.id, new Date());
      }
    }
    return false;
  }

  /** En serie: cada hash argon2id reserva la memoria configurada (64 MiB por defecto) y en paralelo serían 10×. */
  private async hashCodes(
    codes: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string>> {
    const hashes: string[] = [];
    for (const code of codes) {
      const canonical = normalizeRecoveryCode(code);
      if (canonical === null) {
        throw new Error('Código de recuperación generado con formato inválido');
      }
      hashes.push(await this.hashService.hash(canonical));
    }
    return hashes;
  }

  private async requireUser(userId: string): Promise<AppUser> {
    const user = await this.authUsersRepository.findByIdWithPerson(userId);
    if (!user) {
      throw new ApiException(ErrorCode.Unauthorized);
    }
    return user;
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    performedBy: string,
    context: MfaRequestContext,
    changes: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    await this.auditLogsRepository.record(
      {
        action,
        entityType: USER_ENTITY_TYPE,
        entityId,
        performedBy,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        changes,
      },
      manager,
    );
  }
}

const isExpired = (createdAt: Date): boolean =>
  createdAt.getTime() + MFA_PENDING_TTL_MS <= Date.now();
