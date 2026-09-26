import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  LOAN_RETURN_CONDITIONS,
  LOAN_STATUSES,
  type LoanReturnCondition,
  type LoanStatus,
} from '../enums/loan-status.js';

export class CreateLoanDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  readonly assets!: string[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly targetCostCenterId!: string;

  @ApiProperty()
  @IsDateString()
  readonly expectedReturnDate!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  readonly justification!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly contactPerson!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly deliveryNotes?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly targetLocationId?: string;
}

export class RejectLoanDto {
  @ApiProperty()
  @IsString()
  @MinLength(5)
  readonly reason!: string;
}

export class DeliverLoanDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Persona que entrega los activos: firma ENTREGA (turno 1) del acta OCI-01-65',
  })
  @IsUUID('4')
  readonly deliveredByPersonId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Persona de Control Interno que da el visto bueno: firma AUDITA (turno 3) del acta OCI-01-65',
  })
  @IsUUID('4')
  readonly controlInternoPersonId!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Observación por activo para la columna OBSERVACION del acta: { "<assetId>": "texto" }',
  })
  @IsOptional()
  @IsObject()
  readonly assetNotes?: Record<string, string>;
}

export class RegenerateDeliveryActDto {
  @ApiProperty({ format: 'uuid', description: 'Firma ENTREGA (turno 1) del acta nueva' })
  @IsUUID('4')
  readonly deliveredByPersonId!: string;

  @ApiProperty({ format: 'uuid', description: 'Firma AUDITA (turno 3, Control Interno) del acta nueva' })
  @IsUUID('4')
  readonly controlInternoPersonId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Corrige la persona de contacto del destino (firma RECIBE, turno 2). Se guarda en el préstamo. Si se omite, sigue la actual',
  })
  @IsOptional()
  @IsUUID('4')
  readonly contactPersonId?: string;

  @ApiProperty({ description: 'Por qué se genera una nueva acta (queda en el evento del préstamo)', minLength: 5 })
  @IsString()
  @MinLength(5)
  readonly reason!: string;
}

export class UndoDeliveryDto {
  @ApiProperty({ description: 'Motivo: queda en el acta anulada, en el evento y en los movimientos de reversión', minLength: 5 })
  @IsString()
  @MinLength(5)
  readonly reason!: string;
}

export class ReceiveReturnDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', format: 'uuid' },
    description:
      'Firmantes del acta de devolución (LOAN_RETURN) por rol, { "<ROL>": "<personId>" }, para los turnos de origen REQUEST del catálogo. ' +
      'Hoy el formato no tiene firmantes definidos: se ignora y el acta queda pendiente de formato institucional.',
  })
  @IsOptional()
  @IsObject()
  readonly returnActSigners?: Record<string, string>;
}

export class ReturnedAssetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly assetId!: string;

  @ApiProperty({ enum: LOAN_RETURN_CONDITIONS, enumName: 'LoanReturnCondition' })
  @IsIn(LOAN_RETURN_CONDITIONS)
  readonly condition!: LoanReturnCondition;

  @ApiPropertyOptional({
    type: 'string',
    format: 'date-time',
    description: 'Fecha real en que volvió el activo. Por defecto, ahora. No puede ser futura ni anterior a la entrega.',
  })
  @IsOptional()
  @IsDateString()
  readonly returnedAt?: string;
}

export class ReturnLoanDto {
  @ApiProperty({ type: () => [ReturnedAssetDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnedAssetDto)
  readonly assetsReturned!: ReturnedAssetDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class ExtendLoanDto {
  @ApiProperty({ type: 'string', format: 'date', description: 'Nueva fecha estimada de devolución: posterior a la vigente y no pasada' })
  @IsDateString()
  readonly expectedReturnDate!: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  readonly reason!: string;
}

export class QueryLoansDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ enum: LOAN_STATUSES, enumName: 'LoanStatus' })
  @IsOptional()
  @IsIn(LOAN_STATUSES)
  readonly status?: LoanStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly sourceCostCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly targetCostCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly requestedBy?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'true: solo préstamos con activos fuera y sin recepción en curso (PENDING_SIGNATURES, ACTIVE, OVERDUE, PARTIALLY_RETURNED) con la fecha estimada de devolución ya pasada (hoy en Bogotá)',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  readonly overdue?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'true: solo préstamos con activos fuera (PENDING_SIGNATURES, ACTIVE, OVERDUE, PENDING_RECEPTION, PARTIALLY_RETURNED)',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  readonly active?: 'true' | 'false';
}
