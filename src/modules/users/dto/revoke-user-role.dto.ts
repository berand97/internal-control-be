import { AuditReason } from '../../../common/validation/audit-reason.decorator.js';

/** Cuerpo de DELETE /users/:id/roles/:userRoleId: revocar un rol exige motivo (queda en revocation_reason y bitácora). */
export class RevokeUserRoleDto {
  @AuditReason('Motivo de la revocación.')
  readonly reason!: string;
}
