import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IDENTITY_DOCUMENT_TYPE_CODES } from '../../../common/identity/identity-document-types.js';
import { IsBoolean, IsDateString, IsOptional, IsUUID } from 'class-validator';
import { AuditReason } from '../../../common/validation/audit-reason.decorator.js';

export class AssignCostCenterHeadDto {
  @ApiProperty({ format: 'uuid', description: 'Persona que dirige el centro' })
  @IsUUID()
  readonly personId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly costCenterId!: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Desde cuándo dirige el centro; por defecto, ahora' })
  @IsOptional()
  @IsDateString()
  readonly validFrom?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Hasta cuándo; vacío = sin fecha de fin' })
  @IsOptional()
  @IsDateString()
  readonly validUntil?: string;

  @AuditReason('Motivo o soporte de la designación (acto administrativo, correo, …).')
  readonly reason!: string;
}

export class EndCostCenterHeadDto {
  @AuditReason('Motivo de la terminación.')
  readonly reason!: string;
}

export class QueryCostCenterHeadsDto {
  @ApiPropertyOptional({ description: 'Solo jefaturas vigentes hoy (por defecto, también el historial)' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  })
  @IsBoolean()
  readonly current?: boolean;
}

export class CostCenterHeadDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty({ description: 'Nombres y apellidos' })
  readonly personName!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Cargo' })
  readonly positionTitle!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly costCenterId!: string;

  @ApiProperty()
  readonly costCenterCode!: string;

  @ApiProperty()
  readonly costCenterName!: string;

  @ApiProperty({ format: 'date-time' })
  readonly validFrom!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly validUntil!: string | null;

  @ApiProperty({ description: 'Vigente hoy: validFrom <= ahora y validUntil vacío o posterior' })
  readonly isCurrent!: boolean;

  @ApiProperty()
  readonly reason!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Usuario que la asignó' })
  readonly assignedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien la asignó (nombres y apellidos, o su usuario)' })
  readonly assignedByName!: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly assignedAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly endedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Usuario que la terminó' })
  readonly endedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien la terminó (nombres y apellidos, o su usuario)' })
  readonly endedByName!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly endReason!: string | null;
}

export class IdentityDocumentTypeDto {
  @ApiProperty({ enum: IDENTITY_DOCUMENT_TYPE_CODES, enumName: 'IdentityDocumentType', description: 'Código guardado en person.document_type' })
  readonly code!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({ description: 'Lo que imprimen las actas antes del número' })
  readonly abbreviation!: string;
}
