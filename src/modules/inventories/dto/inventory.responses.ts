import { ApiProperty } from '@nestjs/swagger';
import { PHYSICAL_CONDITIONS, PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import {
  BOOK_VALUE_SOURCES,
  type BookValueSource,
  RECONCILIATION_BASIS_KINDS,
  type ReconciliationBasisKind,
} from '../domain/inventory-valuation.js';
import { INVENTORY_CORRECTION_KINDS, type InventoryCorrectionKind } from '../entities/inventory-item-correction.entity.js';
import { SURPLUS_RESOLUTIONS, type SurplusResolution } from '../entities/physical-inventory-item.entity.js';
import {
  INVENTORY_ACT_GENERATIONS,
  INVENTORY_ACT_REASONS,
  INVENTORY_ACT_RETRY_ACTIONS,
  type InventoryActGeneration,
  type InventoryActReason,
  type InventoryActRetryAction,
} from '../domain/inventory-act.js';
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

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Código del activo (visible vigente, si no el heredado, si no el interno), del ítem o, en un sobrante resuelto, ' +
      'del creado. null: sobrante sin activo',
  })
  readonly assetCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly assetDescription!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Código heredado (placa anterior) o código de barras' })
  readonly assetLegacyCode!: string | null;

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

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien verificó (persona o, sin persona, usuario)' })
  readonly verifiedByName!: string | null;

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

  @ApiProperty({
    type: 'number',
    nullable: true,
    description:
      'Precio de compra registrado del activo (del ítem o, en un sobrante resuelto, del creado). null: sin activo. ' +
      '0 es un precio registrado (ver priceIsZero)',
  })
  readonly acquisitionPrice!: number | null;

  @ApiProperty({ description: 'El precio de compra registrado es 0' })
  readonly priceIsZero!: boolean;

  @ApiProperty({
    type: 'number',
    nullable: true,
    description:
      'Valor en libros: la línea del corte contable asociado o, si no trae valor, la última depreciación calculada ' +
      'hasta la fecha de valoración. null = sin dato (nunca un 0 inventado)',
  })
  readonly bookValue!: number | null;

  @ApiProperty({ enum: BOOK_VALUE_SOURCES, enumName: 'BookValueSource', nullable: true })
  readonly bookValueSource!: BookValueSource | null;

  @ApiProperty({
    enum: SURPLUS_RESOLUTIONS,
    enumName: 'SurplusResolution',
    nullable: true,
    description: 'Solo sobrantes sin activo, con la toma cerrada: CREATE_ASSET (activo creado) o LEAVE_UNRESOLVED',
  })
  readonly surplusResolution!: SurplusResolution | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly surplusResolutionReason!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Activo creado a partir del sobrante' })
  readonly resolvedAssetId!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly resolvedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly resolvedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien resolvió el sobrante' })
  readonly resolvedByName!: string | null;
}

export class InventoryReconciliationBasisDto {
  @ApiProperty({
    enum: RECONCILIATION_BASIS_KINDS,
    enumName: 'ReconciliationBasisKind',
    description: 'ACCOUNTING_CUT: contra el corte contable asociado; SYSTEM_SNAPSHOT: contra la foto del sistema',
  })
  readonly kind!: ReconciliationBasisKind;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly cutId!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly cutDate!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly sourceLabel!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Instante de la foto al iniciar; null si no ha iniciado o se inició antes de guardarlo',
  })
  readonly snapshotAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true, description: 'Fecha (Bogotá) de la foto' })
  readonly snapshotDate!: string | null;

  @ApiProperty({
    format: 'date',
    description: 'Fecha hasta la que se lee la depreciación: la del corte, la de la foto o, sin foto, hoy',
  })
  readonly valuationDate!: string;
}

export class InventoryActStateDto {
  @ApiProperty({
    enum: INVENTORY_ACT_GENERATIONS,
    enumName: 'InventoryActGeneration',
    description:
      'NONE: sin conciliar; NOT_ENQUEUED: la conciliación no pudo encolarla (ver reason); PENDING: en cola; ' +
      'FAILED: el motor no pudo generarla (ver reason); GENERATED: acta emitida',
  })
  readonly generation!: InventoryActGeneration;

  @ApiProperty({ enum: INVENTORY_ACT_REASONS, enumName: 'InventoryActReason', nullable: true })
  readonly reason!: InventoryActReason | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Explicación para mostrar' })
  readonly message!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly requestId!: string | null;

  @ApiProperty({ type: 'integer' })
  readonly attempts!: number;

  @ApiProperty({ description: 'FAILED con reintentos automáticos pendientes (el job lo intenta cada minuto)' })
  readonly retriesAutomatically!: boolean;

  @ApiProperty()
  readonly retryable!: boolean;

  @ApiProperty({
    enum: INVENTORY_ACT_RETRY_ACTIONS,
    enumName: 'InventoryActRetryAction',
    nullable: true,
    description:
      'ENQUEUE: POST /inventories/{id}/acts/{costCenterId}/enqueue; RETRY_REQUEST: POST /documents/requests/{requestId}/retry',
  })
  readonly retryAction!: InventoryActRetryAction | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly number!: string | null;

  @ApiProperty({ type: 'string', enum: ['PENDING_SIGNATURE', 'SIGNED', 'REJECTED'], nullable: true })
  readonly status!: 'PENDING_SIGNATURE' | 'SIGNED' | 'REJECTED' | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly blockedAt!: string | null;
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

  @ApiProperty({ type: () => InventoryReconciliationBasisDto })
  readonly reconciliationBasis!: InventoryReconciliationBasisDto;

  @ApiProperty({ example: 'TF-2026-014' })
  readonly code!: string;

  @ApiProperty({ enum: INVENTORY_STATUSES, enumName: 'InventoryStatus' })
  readonly status!: InventoryStatus;
}

export class InventorySignerHeadDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty({ description: 'Nombre y apellidos' })
  readonly name!: string;
}

export class InventoryAttendedByDto {
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null si se registró como texto libre' })
  readonly personId!: string | null;

  @ApiProperty()
  readonly name!: string;
}

export const INVENTORY_WARNING_CODES = ['ACT_CANNOT_BE_ISSUED'] as const;

export class InventoryWarningDto {
  @ApiProperty({
    enum: INVENTORY_WARNING_CODES,
    enumName: 'InventoryWarningCode',
    description: 'ACT_CANNOT_BE_ISSUED: el centro del acta no tiene jefe vigente que la firme como ENCARGADO (o tiene varios y no se eligió)',
  })
  readonly code!: (typeof INVENTORY_WARNING_CODES)[number];

  @ApiProperty({ description: 'Explicación para mostrar' })
  readonly message!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Centro de costo del acta que no se puede emitir' })
  readonly costCenterId!: string | null;
}

export class InventoryCostCenterRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código del centro (external_code)', example: '1020' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

/** Un acta OCI-21-37 de la toma: la de un centro de costo. */
export class InventoryActDto extends InventoryActStateDto {
  @ApiProperty({ format: 'uuid', description: 'Acta de la toma para el centro (entityId del documento en el motor)' })
  readonly id!: string;

  @ApiProperty({
    type: () => InventoryCostCenterRefDto,
    nullable: true,
    description: 'Centro de costo del acta. null solo en el acta única de una toma encolada antes de la división por centro',
  })
  readonly costCenter!: InventoryCostCenterRefDto | null;

  @ApiProperty({
    type: () => InventorySignerHeadDto,
    nullable: true,
    description: 'Jefe vigente del centro que firma esta acta como ENCARGADO; null si el centro no tiene jefe o no se eligió',
  })
  readonly signerHead!: InventorySignerHeadDto | null;

  @ApiProperty({
    type: () => InventoryAttendedByDto,
    nullable: true,
    description: 'Quién atendió por el área de este centro (persona del sistema o texto libre). Solo informativo: no firma',
  })
  readonly attendedBy!: InventoryAttendedByDto | null;

  @ApiProperty({ description: 'El acta tiene quién firme como ENCARGADO (o ya se encoló)' })
  readonly issuable!: boolean;

  @ApiProperty({
    type: () => InventoryWarningDto,
    isArray: true,
    description: 'Con la toma cerrada o conciliada y sin jefe que firme esta acta: [ACT_CANNOT_BE_ISSUED]',
  })
  readonly warnings!: InventoryWarningDto[];
}

export class InventoryCenterHeadCandidatesDto {
  @ApiProperty({ type: () => InventoryCostCenterRefDto })
  readonly costCenter!: InventoryCostCenterRefDto;

  @ApiProperty({
    type: () => InventorySignerHeadDto,
    isArray: true,
    description: 'Jefes vigentes (persona activa) del centro; vacío si no tiene',
  })
  readonly candidates!: InventorySignerHeadDto[];
}

export class InventoryDetailResponseDto extends InventorySummaryDto {
  @ApiProperty({ type: () => InventoryItemDto, isArray: true })
  readonly items!: InventoryItemDto[];

  @ApiProperty({ type: () => InventoryProgressDto })
  readonly progress!: InventoryProgressDto;

  @ApiProperty({
    type: () => InventoryReportDto,
    description:
      'Calculado en vivo; con la toma cerrada, lo congelado al cerrar (discrepancy_report) prevalece, salvo valoración ' +
      'y resolución de sobrantes, que salen siempre en vivo',
  })
  readonly report!: InventoryReportDto;

  @ApiProperty({ type: () => InventoryReconciliationBasisDto, description: 'Contra qué se compara la toma' })
  readonly reconciliationBasis!: InventoryReconciliationBasisDto;

  @ApiProperty({
    type: () => InventoryActDto,
    isArray: true,
    description:
      'Actas OCI-21-37 de la toma, una por centro de costo presente en sus ítems (por código de centro). Se crean al ' +
      'cerrar; vacío antes',
  })
  readonly acts!: InventoryActDto[];

  @ApiProperty({
    type: () => InventoryActStateDto,
    nullable: true,
    description:
      'Compatibilidad: estado de la única acta (NONE antes del cierre); null si la toma tiene varias (ver acts)',
  })
  readonly act!: InventoryActStateDto | null;

  @ApiProperty({
    type: () => InventorySignerHeadDto,
    nullable: true,
    description: 'Compatibilidad: firmante de la única acta; null antes del cierre, sin jefe o con varias actas (ver acts)',
  })
  readonly signerHead!: InventorySignerHeadDto | null;

  @ApiProperty({
    type: () => InventoryAttendedByDto,
    nullable: true,
    description: 'Compatibilidad: quién atendió en la única acta; null con varias actas (ver acts)',
  })
  readonly attendedBy!: InventoryAttendedByDto | null;

  @ApiProperty({ description: 'Todas las actas tienen quién firme como ENCARGADO (o ya se encolaron)' })
  readonly actIssuable!: boolean;

  @ApiProperty({
    type: () => InventoryWarningDto,
    isArray: true,
    description:
      'Con la toma cerrada o conciliada, uno ACT_CANNOT_BE_ISSUED por acta sin jefe que firme (con su costCenterId). ' +
      'Informativo: la toma y las demás actas siguen',
  })
  readonly warnings!: InventoryWarningDto[];

  @ApiProperty({
    type: 'integer',
    description:
      'Ítems vigentes que no van a ninguna acta: sobrantes sin activo ni resolución y activos sin centro en la foto ' +
      '(solo en tomas que no son de un centro de costo)',
  })
  readonly unassignedItems!: number;
}

// ---------- Corte contable ----------

export class AccountingCutDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'date' })
  readonly cutDate!: string;

  @ApiProperty()
  readonly sourceLabel!: string;

  @ApiProperty({
    type: 'string',
    enum: ['MANUAL', 'IMPORT'],
    description: 'MANUAL: fecha y fuente registradas a mano; IMPORT: con líneas importadas (aún no disponible)',
  })
  readonly sourceKind!: 'MANUAL' | 'IMPORT';

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly stagingImportId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly notes!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly createdBy!: string;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'integer', description: 'Líneas (activos con valor) del corte' })
  readonly lineCount!: number;

  @ApiProperty({ type: 'integer', description: 'Tomas asociadas' })
  readonly inventoryCount!: number;
}

export class InventoryAccountingCutResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly inventoryId!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly accountingCutId!: string | null;

  @ApiProperty({ type: () => InventoryReconciliationBasisDto })
  readonly reconciliationBasis!: InventoryReconciliationBasisDto;
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

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Nombre de quien corrigió (persona o, sin persona, usuario); null si el usuario ya no existe',
  })
  readonly correctedByName!: string | null;

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
