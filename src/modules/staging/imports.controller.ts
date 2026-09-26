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
} from './dto/import.responses.js';
import {
  fieldsFor,
  IMPORT_TARGETS,
  type ImportTarget,
  UNKNOWN_COST_CENTER_POLICIES,
  type UnknownCostCenterPolicy,
} from './import/import-fields.js';
import { ExcelImportService } from './services/excel-import.service.js';

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
@ApiExtraModels(ApiSuccessEnvelope, ImportPreviewResponseDto, ImportResultDto, ImportTargetFieldsDto, ImportQuarantineRowDto)
@Feature('assets')
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ExcelImportService) {}

  @Post()
  @RequirePermission('asset:create:global')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir un Excel: devuelve sus hojas y las columnas detectadas' })
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
      })),
      rules:
        known === 'PERSONS'
          ? [
              'Nombre: fullName (se guarda sin partir, marca NAME_NOT_SPLIT) o firstName + lastName, no ambos',
              'Tipo de documento: columna documentType o documentType declarado en la vista previa, no ambos',
              'Sin correo institucional la fila va a cuarentena (EMAIL_MISSING / EMAIL_NOT_INSTITUTIONAL)',
              'Centro de costo inexistente: cuarentena (unknownCostCenters=create no aplica)',
            ]
          : [],
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
  @HttpCode(200)
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Confirmar: inserta solo lo nuevo y pone en cuarentena lo demás' })
  @ApiOkResponse({ schema: envelopedSchema(ImportResultDto) })
  confirm(
    @Param('importId', ParseUUIDPipe) importId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.imports.confirm(importId, actor.id);
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
}
