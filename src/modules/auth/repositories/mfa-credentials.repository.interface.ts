import type { EntityManager } from 'typeorm';

export interface MfaPendingEnrollment {
  readonly secret: string;
  readonly createdAt: Date;
}

export interface StoredRecoveryCode {
  readonly id: string;
  readonly codeHash: string;
}

/**
 * Estado del segundo factor fuera del flujo de login: secreto pendiente, códigos de recuperación y marca de sesión
 * verificada con MFA. Los métodos que reciben `manager` corren dentro de la transacción del llamador.
 */
export interface MfaCredentialsRepository {
  lockUser(userId: string, manager: EntityManager): Promise<void>;
  findPending(
    userId: string,
    manager?: EntityManager,
  ): Promise<MfaPendingEnrollment | null>;
  savePending(userId: string, secret: string, at: Date): Promise<void>;
  activate(userId: string, secret: string, manager: EntityManager): Promise<void>;
  clear(
    userId: string,
    enrollmentRequired: boolean,
    manager: EntityManager,
  ): Promise<void>;
  replaceRecoveryCodes(
    userId: string,
    codeHashes: ReadonlyArray<string>,
    manager: EntityManager,
  ): Promise<void>;
  deleteRecoveryCodes(userId: string, manager: EntityManager): Promise<number>;
  findUnusedRecoveryCodes(
    userId: string,
  ): Promise<ReadonlyArray<StoredRecoveryCode>>;
  consumeRecoveryCode(id: string, at: Date): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  markSessionMfaVerified(
    userId: string,
    sessionId: string,
    at: Date,
    manager?: EntityManager,
  ): Promise<void>;
  isMfaSession(userId: string, sessionId: string): Promise<boolean>;
  revokeSessions(
    userId: string,
    keepSessionId: string | null,
    at: Date,
    manager: EntityManager,
  ): Promise<number>;
}
