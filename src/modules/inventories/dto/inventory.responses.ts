import { ApiProperty } from '@nestjs/swagger';
import { PHYSICAL_CONDITIONS, PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { INVENTORY_CORRECTION_KINDS, type InventoryCorrectionKind } from '../entities/inventory-item-correction.entity.js';
import { INVENTORY_STATUSES, InventoryStatus } from '../enums/inventory-status.js';
import { VERIFICATION_RESULTS, VerificationResult } from '../enums/verification-result.js';
import { SUGGESTIBLE_RESULTS } from './inventory-catalog.dto.js';
import { InventorySummaryDto } from './inventory-schedule.responses.js';

/**
 * Esquemas de respuesta de la ejecución de tomas (detalle, listado, ítems, progreso, reporte, correcciones) y de sus
 * catálogos. Documentan lo que devuelven InventoriesService, InventoryCorrectionsService, InventoryCatalogsService e
 * inventory-item-view.ts: cambiar un shape exige cambiar ambos.
 */

const RESULT_DESCRIPTION =
  'PENDING: sin verificar; FOUND: en su lugar; MISPLACED: en otra ubicación; MISSING: no encontrado (con causa); ' +
  'SURPLUS: sobrante fuera del alcance; NOT_VERIFIED: seguía pendiente al cerrar (no es faltante, la conciliación ' +
  'no lo toca)';

export class InventoryItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null: sobrante sin activo registrado' })
  readonly assetId!: string | null;

  @ApiProperty({ enum: VERIFICATION_RESULTS, enumName: 'VerificationResult', description: RESULT_DESCRIPTION })
  readonly result!: VerificationResult;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly expectedLocationId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly actualLocationId!: string | null;

  @ApiProperty({ enum: PHYSICAL_CONDITIONS, enumName: 'PhysicalCondition', nullable: true })
  readonly expectedCondition!: PhysicalCondition | null;

  @ApiProperty({ enum: PHYSICAL_CONDITIONS, enumName: 'PhysicalCondition', nullable: true })
  readonly actualCondition!: PhysicalCondition | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly expectedCostCenterId!: string | null;

  @ApiProperty({
    type: 'boolean',
    nullable: true,
    description:
      'El activo tenía código TEMP (marca BARCODE_TEMP) al congelar la foto. null: foto anterior a este dato o sobrante',
  })
  readonly expectedCodeTemporary!: boolean | null;

  @ApiProperty()
  readonly isOnLoan!: boolean;

  @ApiProperty({ description: 'Sobrante de un activo que estaba LOST: la conciliación no lo recupera' })
  readonly wasLost!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly verifiedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly verifiedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly notes!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Causa del catálogo (solo MISSING)' })
  readonly missingCauseId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly missingCauseLabel!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Causa "Otra" en texto (solo MISSING)' })
  readonly missingCauseOther!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Categoría de hallazgo fijada por el auditor' })
  readonly findingCategory!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Categoría sugerida por la configuración del catálogo; nunca se asigna sola',
  })
  readonly suggestedCategory!: string | null;

  @ApiProperty({ description: 'Sobrante anulado por error (no cuenta en el progreso ni en el reporte)' })
  readonly voided!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly voidedAt!: string | null;
}

export class InventoryProgressDto {
  @ApiProperty({ type: 'integer', description: 'Ítems esperados (todo menos sobrantes)' })
  readonly expected!: number;

  @ApiProperty({ type: 'integer' })
  readonly pending!: number;

  @ApiProperty({ type: 'integer', description: 'FOUND + MISPLACED' })
  readonly verified!: number;

  @ApiProperty({ type: 'integer' })
  readonly notFound!: number;

  @ApiProperty({ type: 'integer' })
  readonly misplaced!: number;

  @ApiProperty({ type: 'integer', description: 'Pendientes al cerrar' })
  readonly notVerified!: number;

  @ApiProperty({ type: 'integer', description: 'Sobrantes vigentes (sin anulados)' })
  readonly unexpected!: number;

  @ApiProperty({ type: 'integer' })
  readonly voidedUnexpected!: number;

  @ApiProperty({ type: 'integer' })
  readonly onLoan!: number;

  @ApiProperty({ type: 'integer', description: 'Esperados con código TEMP' })
  readonly temporaryCode!: number;

  @ApiProperty({ type: 'number', description: 'verified / expected en porcentaje (dos decimales); 100 sin esperados' })
  readonly percentVerified!: number;
}

export class InventoryProgressResponseDto extends InventoryProgressDto {
  @ApiProperty({ format: 'uuid' })
  readonly inventoryId!: string;

  @ApiProperty({ enum: INVENTORY_STATUSES, enumName: 'InventoryStatus' })
  readonly status!: InventoryStatus;
}

export class InventoryReportDto extends InventoryProgressDto {
  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly verifiedItems!: InventoryItemDto[];

  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly notFoundItems!: InventoryItemDto[];

  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly locationDiscrepancies!: InventoryItemDto[];

  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly notVerifiedItems!: InventoryItemDto[];

  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly unexpectedItems!: InventoryItemDto[];
}

export class InventoryReportResponseDto extends InventoryReportDto {
  @ApiProperty({ format: 'uuid' })
  readonly inventoryId!: string;

  @ApiProperty({ example: 'TF-2026-014' })
  readonly code!: string;

  @ApiProperty({ enum: INVENTORY_STATUSES, enumName: 'InventoryStatus' })
  readonly status!: InventoryStatus;
}

export class InventoryDetailResponseDto extends InventorySummaryDto {
  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly items!: InventoryItemDto[];

  @ApiProperty({ type: () => InventoryProgressDto })
  readonly progress!: InventoryProgressDto;

  @ApiProperty({
    type: () => InventoryReportDto,
    description: 'Calculado en vivo; con la toma cerrada, lo congelado al cerrar (discrepancy_report) prevalece',
  })
  readonly report!: InventoryReportDto;
}

export class InventoryListResponseDto {
  @ApiProperty({ type: () => InventorySummaryDto, isArray: true })
  readonly items!: InventorySummaryDto[];

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

// ---------- Correcciones ----------

export class InventoryItemSnapshotDto {
  @ApiProperty({ enum: VERIFICATION_RESULTS, enumName: 'VerificationResult' })
  readonly result!: VerificationResult;

  @ApiProperty({ enum: PHYSICAL_CONDITIONS, enumName: 'PhysicalCondition', nullable: true })
  readonly actualCondition!: PhysicalCondition | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly actualLocationId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly missingCauseId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly missingCauseOther!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly findingCategory!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly verifiedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly verifiedBy!: string | null;

  @ApiProperty()
  readonly voided!: boolean;
}

export class InventoryItemCorrectionDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly itemId!: string;

  @ApiProperty({ format: 'uuid' })
  readonly inventoryId!: string;

  @ApiProperty({
    enum: INVENTORY_CORRECTION_KINDS,
    enumName: 'InventoryCorrectionKind',
    description: 'CORRECT: cambio de resultado; VOID: anulación de un sobrante',
  })
  readonly kind!: InventoryCorrectionKind;

  @ApiProperty({ type: () => InventoryItemSnapshotDto })
  readonly before!: InventoryItemSnapshotDto;

  @ApiProperty({ type: () => InventoryItemSnapshotDto })
  readonly after!: InventoryItemSnapshotDto;

  @ApiProperty()
  readonly reason!: string;

  @ApiProperty({ format: 'uuid' })
  readonly correctedBy!: string;

  @ApiProperty({ format: 'date-time' })
  readonly correctedAt!: string;
}

export class InventoryItemCorrectionResultDto {
  @ApiProperty({ type: () => InventoryItemDto })
  readonly item!: InventoryItemDto;

  @ApiProperty({ type: () => InventoryItemCorrectionDto })
  readonly correction!: InventoryItemCorrectionDto;
}

// ---------- Catálogos ----------

export class InventoryFindingCategoryDto {
  @ApiProperty({ example: 'AU' })
  readonly code!: string;

  @ApiProperty({ example: 'En uso' })
  readonly label!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly description!: string | null;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({ type: 'integer' })
  readonly sortOrder!: number;

  @ApiProperty({ type: 'array', items: { type: 'string', enum: [...SUGGESTIBLE_RESULTS] }, nullable: true })
  readonly suggestResults!: string[] | null;

  @ApiProperty({ type: 'array', items: { type: 'string', enum: [...PHYSICAL_CONDITIONS] }, nullable: true })
  readonly suggestConditions!: string[] | null;

  @ApiProperty({ description: 'Sin definición: no se sugiere ni se asigna' })
  readonly pendingDefinition!: boolean;

  @ApiProperty({ description: 'Asignada a algún ítem: no se puede borrar, solo desactivar' })
  readonly inUse!: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt!: string;
}

export class InventoryMissingCauseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({ type: 'integer' })
  readonly sortOrder!: number;

  @ApiProperty({ description: 'Usada en algún faltante: no se puede borrar, solo desactivar' })
  readonly inUse!: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt!: string;
}

export class InventoryOtherCauseUsageItemDto {
  @ApiProperty({ description: 'Texto más reciente del grupo (se agrupa sin distinguir mayúsculas ni espacios)' })
  readonly text!: string;

  @ApiProperty({ type: 'integer', description: 'Faltantes con este texto' })
  readonly count!: number;

  @ApiProperty({ type: 'integer', description: 'Tomas distintas donde aparece' })
  readonly inventories!: number;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly lastUsedAt!: string | null;
}

export class InventoryOtherCauseUsageResponseDto {
  @ApiProperty({ type: () => InventoryOtherCauseUsageItemDto, isArray: true })
  readonly items!: InventoryOtherCauseUsageItemDto[];

  @ApiProperty({ type: 'integer', description: 'Faltantes con causa "Otra" en total' })
  readonly total!: number;
}

export class InventoryDeletedResponseDto {
  @ApiProperty()
  readonly deleted!: boolean;
}
