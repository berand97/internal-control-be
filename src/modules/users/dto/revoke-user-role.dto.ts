import { AuditReason } from '../../../common/validation/audit-reason.decorator.js';

export class RevokeUserRoleDto {
  @AuditReason('Motivo de la revocación.')
  readonly reason!: string;
}
