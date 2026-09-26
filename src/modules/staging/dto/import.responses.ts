import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EMPTY_EFFECTS, FIELD_KINDS, IMPORT_TARGETS, TEMPLATE_CATALOGS } from '../import/import-fields.js';

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

  @ApiProperty({ description: 'Encabezado exacto de la columna en la plantilla; el importador lo reconoce al subir' })
  readonly header!: string;

  @ApiProperty({ enum: FIELD_KINDS, enumName: 'ImportFieldKind' })
  readonly kind!: (typeof FIELD_KINDS)[number];

  @ApiProperty({ enum: TEMPLATE_CATALOGS, enumName: 'ImportTemplateCatalog', nullable: true })
  readonly catalog!: (typeof TEMPLATE_CATALOGS)[number] | null;

  @ApiProperty({ description: 'Formato esperado' })
  readonly format!: string;

  @ApiProperty({
    enum: EMPTY_EFFECTS,
    enumName: 'ImportEmptyEffect',
    description:
      'Celda vacía: QUARANTINE = la fila no se importa (obligatoria en la plantilla); FLAG = se importa con marca; NONE = queda vacío',
  })
  readonly whenEmpty!: (typeof EMPTY_EFFECTS)[number];

  @ApiProperty({ description: 'Qué pasa si la celda se deja vacía' })
  readonly whenEmptyText!: string;

  @ApiProperty({ description: 'El campo va en la plantilla descargable' })
  readonly inTemplate!: boolean;
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

export class ImportMissingTemplateColumnDto {
  @ApiProperty({ description: 'Campo destino' })
  readonly field!: string;

  @ApiProperty({ description: 'Encabezado de la columna en la plantilla vigente' })
  readonly header!: string;

  @ApiProperty({ description: 'Obligatoria en la plantilla: sin ella cada fila va a cuarentena' })
  readonly required!: boolean;
}

export class ImportUnmappedColumnDto {
  @ApiProperty({ description: 'Letra de la columna' })
  readonly column!: string;

  @ApiProperty({ description: 'Encabezado en el archivo' })
  readonly header!: string;
}

export class ImportTemplateUsageDto {
  @ApiProperty({ description: 'Destino de la plantilla (normalmente un ImportTarget)' })
  readonly target!: string;

  @ApiProperty({ description: 'Versión de la plantilla del archivo' })
  readonly version!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Versión vigente para ese destino' })
  readonly currentVersion!: string | null;

  @ApiProperty({ description: 'La plantilla del archivo no es la vigente' })
  readonly outdated!: boolean;

  @ApiProperty({ description: 'Este entorno generó esa versión (está en el historial)' })
  readonly knownVersion!: boolean;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Primera generación de esa versión en este entorno',
  })
  readonly versionGeneratedAt!: string | null;

  @ApiProperty({
    type: [ImportMissingTemplateColumnDto],
    description: 'Columnas de la plantilla vigente que el archivo no trae: se tratan como vacías',
  })
  readonly missingColumns!: ImportMissingTemplateColumnDto[];

  @ApiProperty({ type: 'integer', isArray: true, description: 'Filas idénticas a la fila de ejemplo: no se importan' })
  readonly exampleRowsIgnored!: number[];
}

export class ImportSummaryDto {
  @ApiProperty({
    type: [ImportUnmappedColumnDto],
    description: 'Columnas con encabezado que no quedaron asignadas a ningún campo: se ignoran y no se guardan',
  })
  readonly unmappedColumns!: ImportUnmappedColumnDto[];

  @ApiProperty({ type: ImportTemplateUsageDto, nullable: true, description: 'null: el archivo no viene de una plantilla' })
  readonly template!: ImportTemplateUsageDto | null;

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

// ---------- POST /imports ----------

export class ImportUploadedSheetDto {
  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'integer' })
  readonly rows!: number;

  @ApiProperty({ type: 'integer' })
  readonly detectedHeaderRow!: number;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, description: 'Letra → encabezado' })
  readonly columns!: Record<string, string>;
}

export class ImportUploadedTemplateDto {
  @ApiProperty({ description: 'Destino de la plantilla (normalmente un ImportTarget)' })
  readonly target!: string;

  @ApiProperty()
  readonly version!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly currentVersion!: string | null;

  @ApiProperty()
  readonly outdated!: boolean;

  @ApiProperty()
  readonly knownVersion!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly versionGeneratedAt!: string | null;

  @ApiProperty({ description: 'Hoja de datos de la plantilla' })
  readonly dataSheet!: string;

  @ApiProperty({ type: 'integer' })
  readonly headerRow!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Mapeo reconocido por encabezados (campo → letra), listo para la vista previa',
  })
  readonly mapping!: Record<string, string>;

  @ApiProperty({ type: [ImportMissingTemplateColumnDto] })
  readonly missingColumns!: ImportMissingTemplateColumnDto[];
}

export class ImportUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly batchId!: string;

  @ApiProperty({ description: 'false: el mismo archivo ya estaba cargado' })
  readonly created!: boolean;

  @ApiProperty({
    type: [ImportUploadedSheetDto],
    description: 'Hojas del archivo. Si es una plantilla, sin sus hojas internas (instrucciones, catálogos, metadatos)',
  })
  readonly sheets!: ImportUploadedSheetDto[];

  @ApiProperty({
    type: ImportUploadedTemplateDto,
    nullable: true,
    description: 'null: el archivo no viene de una plantilla',
  })
  readonly template!: ImportUploadedTemplateDto | null;
}

// ---------- GET /imports/templates ----------

export class ImportTemplateDto {
  @ApiProperty({ enum: IMPORT_TARGETS, enumName: 'ImportTarget' })
  readonly target!: (typeof IMPORT_TARGETS)[number];

  @ApiProperty({ description: 'Versión vigente: identificador de la definición de campos y reglas' })
  readonly version!: string;

  @ApiProperty({ description: 'SHA-256 de la definición' })
  readonly definitionHash!: string;

  @ApiProperty({ description: 'SHA-256 de definición + catálogos: el archivo se regenera solo si cambia' })
  readonly contentHash!: string;

  @ApiProperty({ description: 'Nombre del archivo de descarga' })
  readonly fileName!: string;

  @ApiProperty({ type: 'integer' })
  readonly byteSize!: number;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'Generación del archivo vigente' })
  readonly generatedAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'Desde cuándo rige esta versión en este entorno' })
  readonly versionSince!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description:
      'Valores de cada catálogo de los desplegables (COST_CENTERS, DOCUMENT_TYPES, CATEGORIES, PHYSICAL_CONDITIONS)',
  })
  readonly catalogCounts!: Record<string, number>;
}
