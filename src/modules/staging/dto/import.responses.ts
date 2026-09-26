import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IMPORT_TARGETS } from '../import/import-fields.js';

/**
 * Esquemas de respuesta de /imports. Solo documentan lo que ExcelImportService ya devuelve: cambiar un shape exige
 * cambiar ambos.
 */

export class ImportFieldDto {
  @ApiProperty({ description: 'Campo destino (clave del mapeo)' })
  readonly field!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty()
  readonly required!: boolean;
}

export class ImportTargetFieldsDto {
  @ApiProperty({ enum: IMPORT_TARGETS, enumName: 'ImportTarget' })
  readonly target!: (typeof IMPORT_TARGETS)[number];

  @ApiProperty({ type: [ImportFieldDto] })
  readonly fields!: ImportFieldDto[];

  @ApiProperty({
    type: [String],
    description:
      'Reglas adicionales del mapeo. PERSONS: fullName o firstName+lastName (no ambos); documentType como columna o declarado en la vista previa (no ambos); un centro inexistente va a cuarentena',
  })
  readonly rules!: string[];
}

export class ImportMetricDto {
  @ApiProperty()
  readonly key!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({ type: 'number', nullable: true })
  readonly value!: number | null;

  @ApiProperty({ type: 'number', nullable: true })
  readonly base!: number | null;

  @ApiPropertyOptional()
  readonly detail?: string;
}

export class ImportSummaryDto {
  @ApiProperty({ type: 'integer' })
  readonly rowsRead!: number;

  @ApiProperty({ type: 'integer' })
  readonly toInsert!: number;

  @ApiProperty({ type: 'integer', description: 'Ya existen en el modelo: se omiten (la importación es idempotente)' })
  readonly alreadyPresent!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description:
      'Filas en cuarentena por motivo. PERSONS: EMPTY_ROW, DOCUMENT_NUMBER_MISSING, DOCUMENT_TYPE_INVALID, DOCUMENT_NUMBER_INVALID, DOCUMENT_NUMBER_DUPLICATED, REQUIRED_FIELD_MISSING, FIELD_TOO_LONG, DOCUMENT_TYPE_CONFLICT, COST_CENTER_UNKNOWN, EMAIL_MISSING, EMAIL_NOT_INSTITUTIONAL',
  })
  readonly quarantined!: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Marcas de calidad de lo que se insertaría. PERSONS: DOCUMENT_TYPE_UNKNOWN, NAME_NOT_SPLIT',
  })
  readonly flagged!: Record<string, number>;

  @ApiProperty({ type: 'integer' })
  readonly issues!: number;

  @ApiProperty({ type: [ImportMetricDto] })
  readonly metrics!: ImportMetricDto[];
}

export class ImportPreviewResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly importId!: string;

  @ApiProperty({ type: ImportSummaryDto })
  readonly summary!: ImportSummaryDto;
}

export class ImportResultSecondsDto {
  @ApiProperty()
  readonly rows!: number;

  @ApiProperty()
  readonly movements!: number;
}

export class ImportResultDto {
  @ApiProperty({ type: 'integer' })
  readonly inserted!: number;

  @ApiProperty({ type: 'integer' })
  readonly skippedAlreadyPresent!: number;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' } })
  readonly quarantined!: Record<string, number>;

  @ApiProperty({ type: 'integer' })
  readonly costCentersCreated!: number;

  @ApiProperty({ type: 'integer' })
  readonly registrationMovements!: number;

  @ApiProperty({ type: ImportResultSecondsDto })
  readonly seconds!: ImportResultSecondsDto;
}

export class ImportQuarantineRowDto {
  @ApiProperty()
  readonly sheet!: string;

  @ApiProperty({ type: 'integer' })
  readonly rowNumber!: number;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Identificador del activo en el origen. En PERSONS siempre null: el número de documento no se copia',
  })
  readonly legacyAssetId!: string | null;

  @ApiProperty()
  readonly reason!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly detail!: string | null;
}
