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
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
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
  @IsString()
  readonly sheet!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly headerRow?: number;

  @IsIn(IMPORT_TARGETS)
  readonly target!: ImportTarget;

  @IsObject()
  readonly mapping!: Record<string, string>;

  @IsOptional()
  @IsIn(UNKNOWN_COST_CENTER_POLICIES)
  readonly unknownCostCenters?: UnknownCostCenterPolicy;
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

  @Post(':batchId/previews')
  @HttpCode(200)
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Mapear columnas y ver el diagnóstico sin escribir nada en el modelo',
  })
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
