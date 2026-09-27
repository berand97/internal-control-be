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

export class CloseInventoryDto {
  @ApiPropertyOptional({
    description:
      'Permite cerrar con más del 5% sin verificar. Requiere inventory:create:global.',
  })
  @IsOptional()
  @IsBoolean()
  readonly allowUnverified?: boolean;
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
