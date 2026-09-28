import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsUUID } from 'class-validator';
import { AuditReason } from '../../../common/validation/audit-reason.decorator.js';

export class DelegateUserRoleDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Usuario que recibe la delegación',
  })
  @IsUUID('4')
  readonly toUserId!: string;

  @ApiProperty({
    description: 'Vencimiento obligatorio de la delegación (ISO 8601)',
  })
  @IsDateString()
  readonly validUntil!: string;

  @AuditReason('Motivo de la delegación (obligatorio).')
  readonly reason!: string;
}
