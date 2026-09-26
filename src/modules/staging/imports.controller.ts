import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  IDENTITY_DOCUMENT_TYPE_CODES,
  type IdentityDocumentType,
} from '../../common/identity/identity-document-types.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  ImportPreviewResponseDto,
  ImportQuarantineRowDto,
  ImportResultDto,
  ImportTargetFieldsDto,
  ImportUploadResponseDto,
} from './dto/import.responses.js';
import {
  fieldsFor,
  IMPORT_TARGETS,
  type ImportTarget,
  TARGET_RULES,
  UNKNOWN_COST_CENTER_POLICIES,
  type UnknownCostCenterPolicy,
} from './import/import-fields.js';
import { ExcelImportService } from './services/excel-import.service.js';
import { ImportJobsService } from './services/import-jobs.service.js';
import { envelopedJobListSchema, ImportJobDto } from './dto/import-job.responses.js';

const MAX_BYTES = 25 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface ExcelUpload {
  readonly originalname: string;
  readonly mimetype: string;
  readonly buffer: Buffer;
  readonly size: number;
}

export class PreviewImportDto {
  @ApiProperty({ description: 'Hoja del archivo' })
  @IsString()
  readonly sheet!: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, description: 'Fila de encabezados; por defecto, la detectada' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly headerRow?: number;

  @ApiProperty({ enum: IMPORT_TARGETS, enumName: 'ImportTarget' })
  @IsIn(IMPORT_TARGETS)
  readonly target!: ImportTarget;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Campo destino → letra de columna (A, B, …). Campos por destino: GET /imports/targets/{target}/fields',
  })
  @IsObject()
  readonly mapping!: Record<string, string>;

  @ApiPropertyOptional({ enum: UNKNOWN_COST_CENTER_POLICIES, enumName: 'UnknownCostCenterPolicy' })
  @IsOptional()
  @IsIn(UNKNOWN_COST_CENTER_POLICIES)
  readonly unknownCostCenters?: UnknownCostCenterPolicy;

  @ApiPropertyOptional({
    enum: IDENTITY_DOCUMENT_TYPE_CODES,
    enumName: 'IdentityDocumentType',
    description:
      'Solo PERSONS y solo si el archivo no trae columna de tipo: el operador declara el tipo de todo el lote (queda registrado como DECLARED_BY_OPERATOR). Si no se declara, las personas se guardan sin tipo con la marca DOCUMENT_TYPE_UNKNOWN',
  })
  @IsOptional()
  @IsIn(IDENTITY_DOCUMENT_TYPE_CODES)
  readonly documentType?: IdentityDocumentType;
}

export class IssuesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  readonly pageSize: number = 200;
}

@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ImportPreviewResponseDto,
  ImportResultDto,
  ImportTargetFieldsDto,
  ImportQuarantineRowDto,
  ImportUploadResponseDto,
  ImportJobDto,
)
@Feature('assets')
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ExcelImportService,
    private readonly jobs: ImportJobsService,
  ) {}

  @Post()
  @RequirePermission('asset:create:global')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir un Excel: devuelve sus hojas y las columnas detectadas',
    description:
      'Si el archivo es una plantilla descargada de GET /imports/templates/{target}, template trae su versión (y si es la vigente) y el mapeo reconocido por encabezados. Un Excel cualquiera sigue funcionando: template es null',
  })
  @ApiOkResponse({ schema: envelopedSchema(ImportUploadResponseDto) })
  upload(@UploadedFile() file: ExcelUpload | undefined, @CurrentUser() actor: AuthenticatedUser) {
    if (!file) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Falta el archivo');
    }
    if (file.mimetype !== XLSX_MIME && !file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new ApiException(ErrorCode.FileTypeNotAllowed);
    }
    return this.imports.upload(file.buffer, file.originalname, actor.id);
  }

  @Get('targets/:target/fields')
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Campos mapeables de un destino de importación' })
  @ApiOkResponse({ schema: envelopedSchema(ImportTargetFieldsDto) })
  targetFields(@Param('target') target: string): ImportTargetFieldsDto {
    const known = IMPORT_TARGETS.find((item) => item === target);
    if (!known) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Destino de importación desconocido');
    }
    return {
      target: known,
      fields: Object.entries(fieldsFor(known)).map(([field, definition]) => ({
        field,
        label: definition.label,
        required: definition.required,
        header: definition.header,
        kind: definition.kind,
        catalog: definition.catalog ?? null,
        format: definition.format,
        whenEmpty: definition.whenEmpty.effect,
        whenEmptyText: definition.whenEmpty.text,
        inTemplate: definition.inTemplate !== false,
      })),
      rules: [...TARGET_RULES[known]],
    };
  }

  @Post(':batchId/previews')
  @HttpCode(200)
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Mapear columnas y ver el diagnóstico sin escribir nada en el modelo',
  })
  @ApiOkResponse({ schema: envelopedSchema(ImportPreviewResponseDto) })
  preview(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() dto: PreviewImportDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.imports.preview(batchId, dto, actor.id);
  }

  @Get('previews/:importId/issues')
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Problemas por fila de una vista previa' })
  issues(@Param('importId', ParseUUIDPipe) importId: string, @Query() query: IssuesQueryDto) {
    return this.imports.issues(importId, query.page, query.pageSize);
  }

  @Post('previews/:importId/confirm')
  @HttpCode(202)
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Confirmar: encola la importación y responde de inmediato con el trabajo',
    description:
      'No escribe en el modelo dentro de la petición: un worker procesa el trabajo en segundo plano (toma trabajos cada 5 s). Consulte el avance con GET /imports/jobs/{id}. Idempotente: confirmar otra vez la misma importación devuelve el mismo trabajo, en el estado en que esté (si FAILED, use POST /imports/jobs/{id}/retry).',
  })
  @ApiAcceptedResponse({ schema: envelopedSchema(ImportJobDto) })
  confirm(
    @Param('importId', ParseUUIDPipe) importId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.jobs.enqueue(importId, actor.id);
  }

  @Get('previews/:importId/reconciliation')
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Conciliación entre el diagnóstico y lo que quedó en el modelo' })
  reconciliation(@Param('importId', ParseUUIDPipe) importId: string) {
    return this.imports.reconcile(importId);
  }

  @Get('previews/:importId/quarantine')
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Filas en cuarentena con motivo y fila original' })
  quarantine(@Param('importId', ParseUUIDPipe) importId: string) {
    return this.imports.quarantine(importId);
  }

  // ---------- Importación asíncrona: trabajos (bej-async-import) ----------

  @Get('jobs')
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Mis trabajos de importación más recientes (máx. 20)',
    description: 'Para retomar el avance si se cerró la página: los trabajos siguen en el servidor.',
  })
  @ApiOkResponse({ schema: envelopedJobListSchema() })
  listJobs(@CurrentUser() actor: AuthenticatedUser) {
    return this.jobs.listMine(actor.id);
  }

  @Get('jobs/:jobId')
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Estado de un trabajo de importación (fase, conteos, porcentaje)',
    description: 'Para polling. 404 RESOURCE_NOT_FOUND si no existe.',
  })
  @ApiOkResponse({ schema: envelopedSchema(ImportJobDto) })
  job(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.find(jobId);
  }

  @Post('jobs/:jobId/retry')
  @HttpCode(202)
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Reintentar un trabajo FAILED sin volver a subir el archivo',
    description:
      'Lo devuelve a la cola (QUEUED). No duplica: si la fase de filas ya había quedado escrita no se repite (sus conteos se conservan) y solo se escriben los movimientos que faltan. 409 IMPORT_JOB_NOT_RETRYABLE si no está FAILED; 404 si no existe.',
  })
  @ApiAcceptedResponse({ schema: envelopedSchema(ImportJobDto) })
  retryJob(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.retry(jobId);
  }

  @Get('previews/:importId/job')
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Trabajo de una importación ya confirmada', description: '404 si la importación no se ha confirmado.' })
  @ApiOkResponse({ schema: envelopedSchema(ImportJobDto) })
  async jobOfImport(@Param('importId', ParseUUIDPipe) importId: string) {
    const job = await this.jobs.findByImport(importId);
    if (!job) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'La importación no tiene trabajo: no se ha confirmado');
    }
    return job;
  }
}
