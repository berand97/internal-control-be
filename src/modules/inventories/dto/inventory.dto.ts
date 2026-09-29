import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import {
  DEFAULT_REMINDER_OFFSETS_DAYS,
  MAX_REMINDER_OFFSET_DAYS,
  MAX_REMINDER_OFFSETS,
} from '../domain/inventory-schedule.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { CORRECTABLE_RESULTS, type CorrectableResult } from '../enums/verification-result.js';

export class CreateInventoryDto {
  @ApiProperty({ example: 'Toma física Talento Humano 2026' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  readonly name!: string;

  @ApiProperty({ enum: InventoryScopeType })
  @IsEnum(InventoryScopeType)
  readonly scope!: InventoryScopeType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly scopeId?: string;

  @ApiProperty()
  @IsDateString()
  readonly plannedStartDate!: string;

  @ApiProperty()
  @IsDateString()
  readonly plannedEndDate!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly responsibleUserId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;

  @ApiPropertyOptional({
    type: [Number],
    default: DEFAULT_REMINDER_OFFSETS_DAYS,
    maxItems: MAX_REMINDER_OFFSETS,
    description:
      'Días antes del inicio en que se envía recordatorio (0 = el mismo día), a las 07:00 de Bogotá. Enteros 0..365, ' +
      'sin repetir, máximo 6. Sin el campo: [30, 15, 1]. [] = sin recordatorios. Los que ya pasaron quedan SKIPPED.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REMINDER_OFFSETS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_REMINDER_OFFSET_DAYS, { each: true })
  readonly reminderOffsetsDays?: number[];
}

export class RescheduleInventoryDto {
  @ApiProperty({ example: '2026-11-09', description: 'Nuevo inicio: hoy (Bogotá) o después' })
  @IsDateString()
  readonly plannedStartDate!: string;

  @ApiProperty({ example: '2026-11-13' })
  @IsDateString()
  readonly plannedEndDate!: string;

  @ApiPropertyOptional({
    type: [Number],
    maxItems: MAX_REMINDER_OFFSETS,
    description: 'Sin el campo se conservan los días de recordatorio actuales de la toma',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REMINDER_OFFSETS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_REMINDER_OFFSET_DAYS, { each: true })
  readonly reminderOffsetsDays?: number[];

  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Coincide con el cierre contable' })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3)
  @MaxLength(500)
  readonly reason!: string;
}

export class CancelInventoryDto {
  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Se hará dentro de la toma general de la sede' })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3)
  @MaxLength(500)
  readonly reason!: string;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InventoryCalendarQueryDto {
  @ApiProperty({ example: '2026-10-01', description: 'Primer día de la ventana (YYYY-MM-DD)' })
  @Matches(CALENDAR_DATE)
  readonly from!: string;

  @ApiProperty({ example: '2026-12-31', description: 'Último día de la ventana (YYYY-MM-DD); máximo 93 días en total' })
  @Matches(CALENDAR_DATE)
  readonly to!: string;

  @ApiPropertyOptional({ default: false, description: 'Incluir tomas canceladas' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  readonly includeCancelled?: boolean;
}

export class VerifyInventoryAssetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly assetId!: string;

  @ApiProperty({ enum: PhysicalCondition })
  @IsEnum(PhysicalCondition)
  readonly condition!: PhysicalCondition;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ReportNotFoundDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly assetId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Causa del catálogo (activa). Exactamente uno de causeId u otherCause.',
  })
  @IsOptional()
  @IsUUID('4')
  readonly causeId?: string;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description: 'Causa "Otra" en texto libre. Exactamente uno de causeId u otherCause.',
  })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(500)
  readonly otherCause?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class CorrectInventoryItemDto {
  @ApiProperty({ enum: CORRECTABLE_RESULTS, enumName: 'InventoryCorrectableResult' })
  @IsIn(CORRECTABLE_RESULTS)
  readonly result!: CorrectableResult;

  @ApiPropertyOptional({
    enum: PhysicalCondition,
    enumName: 'PhysicalCondition',
    description: 'Obligatoria con FOUND y MISPLACED',
  })
  @IsOptional()
  @IsEnum(PhysicalCondition)
  readonly actualCondition?: PhysicalCondition;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Ubicación observada. FOUND: igual a la esperada (o vacía); MISPLACED: obligatoria y distinta de la esperada',
  })
  @IsOptional()
  @IsUUID('4')
  readonly actualLocationId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Con MISSING: causa del catálogo (o otherCause)' })
  @IsOptional()
  @IsUUID('4')
  readonly causeId?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Con MISSING: causa "Otra" (o causeId)' })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(500)
  readonly otherCause?: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    maxLength: 10,
    description: 'Código de categoría de hallazgo; null la quita; sin el campo se conserva (PENDING siempre la quita)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  readonly findingCategory?: string | null;

  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Se escaneó el activo equivocado' })
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(500)
  readonly reason!: string;
}

export class VoidInventoryItemDto {
  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Sobrante registrado dos veces' })
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(500)
  readonly reason!: string;
}

export class SetFindingCategoryDto {
  @ApiProperty({
    type: 'string',
    nullable: true,
    maxLength: 10,
    example: 'AU',
    description: 'Código de una categoría activa y definida; null quita la categoría',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  readonly code!: string | null;
}

export class ReportUnexpectedDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly assetId?: string;

  @ApiPropertyOptional({ enum: PhysicalCondition })
  @IsOptional()
  @IsEnum(PhysicalCondition)
  readonly condition?: PhysicalCondition;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

/** Firmante ENCARGADO del acta de un centro de la toma, elegido al cerrar. */
export class ActSignerHeadChoiceDto {
  @ApiProperty({ format: 'uuid', description: 'Centro de costo del acta (GET /inventories/{id}/acts/head-candidates)' })
  @IsUUID('all')
  readonly costCenterId!: string;

  @ApiProperty({ format: 'uuid', description: 'Jefe vigente de ese centro que firma su acta como ENCARGADO' })
  @IsUUID('all')
  readonly personId!: string;
}

/** Quién atendió por el área de un centro de la toma (solo informativo). */
export class ActAttendedByDto {
  @ApiProperty({ format: 'uuid', description: 'Centro de costo del acta' })
  @IsUUID('all')
  readonly costCenterId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Persona del sistema. No junto con name' })
  @IsOptional()
  @IsUUID('all')
  readonly personId?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 200, description: 'Nombre en texto, si no está registrado' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  readonly name?: string;
}

export class CloseInventoryDto {
  @ApiPropertyOptional({
    description:
      'Permite cerrar con más del 5% sin verificar. Requiere inventory:create:global.',
  })
  @IsOptional()
  @IsBoolean()
  readonly allowUnverified?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Compatibilidad, solo para una toma con un único centro de costo (un acta): el jefe que la firma como ENCARGADO. ' +
      'Con varios centros, 400 VALIDATION_FAILED: use signerHeads. No junto con signerHeads',
  })
  @IsOptional()
  @IsUUID('all')
  readonly signerHeadPersonId?: string;

  @ApiPropertyOptional({
    type: () => ActSignerHeadChoiceDto,
    isArray: true,
    description:
      'Un acta OCI-21-37 por centro de costo de la toma. Por centro: con un solo jefe vigente firma él por defecto; con ' +
      'varios hay que elegir aquí (400 VALIDATION_FAILED, details signerHeads.<costCenterId>); con ninguno el cierre ' +
      'procede, esa acta no se emite hasta indicarlo (PUT /inventories/{id}/acts/{costCenterId}/signer-head) y las demás ' +
      'siguen (aviso ACT_CANNOT_BE_ISSUED). Candidatos: GET /inventories/{id}/acts/head-candidates',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ActSignerHeadChoiceDto)
  readonly signerHeads?: ActSignerHeadChoiceDto[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Quién atendió por el área, si es persona del sistema, para todas las actas que no lo indiquen en attendedBy. ' +
      'Solo informativo: no firma. No junto con attendedByName',
  })
  @IsOptional()
  @IsUUID('all')
  readonly attendedByPersonId?: string;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 200,
    description:
      'Quién atendió por el área, en texto, si no está registrado, para todas las actas que no lo indiquen en attendedBy. ' +
      'Solo informativo',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  readonly attendedByName?: string;

  @ApiPropertyOptional({
    type: () => ActAttendedByDto,
    isArray: true,
    description: 'Quién atendió por el área de cada centro (en una toma por ubicación cada área pudo tener el suyo)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ActAttendedByDto)
  readonly attendedBy?: ActAttendedByDto[];
}

export class AssignSignerHeadDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Jefe vigente del centro del acta (GET /inventories/{id}/acts/head-candidates)',
  })
  @IsUUID('all')
  readonly signerHeadPersonId!: string;
}

export class QueryInventoriesDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ enum: InventoryStatus })
  @IsOptional()
  @IsEnum(InventoryStatus)
  readonly status?: InventoryStatus;

  @ApiPropertyOptional({ enum: InventoryScopeType })
  @IsOptional()
  @IsEnum(InventoryScopeType)
  readonly scope?: InventoryScopeType;
}
