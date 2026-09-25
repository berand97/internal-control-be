import { ApiProperty } from '@nestjs/swagger';
import type { AuditLog } from '../../entities/audit-log.entity.js';

export class LoginEventResponseDto {
  @ApiProperty({
    description: 'Momento del login exitoso',
    format: 'date-time',
  })
  readonly at!: string;

  @ApiProperty({
    type: 'string',
    description: 'Dirección IP desde la que se inició sesión',
    nullable: true,
    example: '190.85.12.34',
  })
  readonly ipAddress!: string | null;

  static from(auditLog: AuditLog): LoginEventResponseDto {
    return {
      at: auditLog.performedAt.toISOString(),
      ipAddress: auditLog.ipAddress,
    };
  }
}
