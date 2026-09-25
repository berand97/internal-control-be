import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsDateString, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { DocumentEngineService } from './services/document-engine.service.js';

export class GenerateDocumentDto {
  @IsString()
  readonly formatKey!: string;

  @IsOptional()
  @IsString()
  readonly entityType?: string;

  @IsOptional()
  @IsUUID()
  readonly entityId?: string;

  @IsOptional()
  @IsUUID()
  readonly costCenterId?: string;

  @IsOptional()
  @IsUUID()
  readonly responsiblePersonId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  readonly assetIds?: string[];

  @IsOptional()
  @IsObject()
  readonly movementIds?: Record<string, string>;

  @IsOptional()
  @IsObject()
  readonly signers?: Record<string, string>;

  @IsOptional()
  @IsObject()
  readonly assetNotes?: Record<string, string>;

  @IsOptional()
  @IsObject()
  readonly fields?: Record<string, string>;
}

export class SignDocumentDto {
  @IsString()
  @MaxLength(90_000)
  readonly rubric!: string;
}

export class RejectSignatureDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

export class UploadTemplateDto {
  @IsString()
  readonly sgcVersion!: string;

  @IsDateString()
  readonly effectiveDate!: string;
}

interface DocxUpload {
  readonly originalname: string;
  readonly buffer: Buffer;
  readonly size: number;
}

@ApiTags(OpenApiTag.DocumentTemplates)
@ApiBearerAuth()
@Feature('document-templates')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly engine: DocumentEngineService) {}

  @Get('formats')
  @RequirePermission('document_template:read:global')
  @ApiOperation({ summary: 'Formatos SGC configurados, plantilla vigente y último consecutivo' })
  formats() {
    return this.engine.formats();
  }

  @Post('formats/:formatKey/templates')
  @RequirePermission('document_template:update:global')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir una versión de plantilla DOCX con su versión SGC y fecha de vigencia' })
  uploadTemplate(
    @Param('formatKey') formatKey: string,
    @UploadedFile() file: DocxUpload | undefined,
    @Body() dto: UploadTemplateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file || !file.originalname.toLowerCase().endsWith('.docx')) {
      throw new ApiException(ErrorCode.FileTypeNotAllowed, 'Se espera un archivo .docx');
    }
    return this.engine.uploadTemplate(formatKey, file, { sgcVersion: dto.sgcVersion, effectiveDate: dto.effectiveDate.slice(0, 10) }, actor.id);
  }

  @Post()
  @ApiOperation({ summary: 'Generar un documento (DOCX y PDF) que queda pendiente de firma' })
  generate(@Body() dto: GenerateDocumentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.engine.generate(dto, actor.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Estado del documento y de sus firmas' })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.engine.detail(id, actor.id);
  }

  @Post(':id/signatures/sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Consultar al proveedor de firma y actualizar el estado' })
  async sync(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.engine.detail(id, actor.id);
    return this.engine.syncSignatures(id);
  }

  @Post(':id/signatures/:order')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Firmar mi turno con la rúbrica dibujada',
    description:
      'Solo la persona designada para ese turno, con MFA activo y sesión vigente. rubric es un PNG en data URL o base64. Se registra quién, cuándo, desde qué IP y bajo qué sesión, y el hash del PDF antes y después.',
  })
  sign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('order', ParseIntPipe) order: number,
    @Body() dto: SignDocumentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    const rubric = Buffer.from(dto.rubric.replace(/^data:image\/png;base64,/, ''), 'base64');
    return this.engine.sign(id, order, actor, rubric, { ipAddress: ipAddress || null, userAgent: userAgent ?? null });
  }

  @Post(':id/signatures/:order/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar la firma de mi turno, con motivo' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('order', ParseIntPipe) order: number,
    @Body() dto: RejectSignatureDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.engine.rejectSignature(id, order, actor, dto.reason, {
      ipAddress: ipAddress || null,
      userAgent: userAgent ?? null,
    });
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Descargar el PDF, con el permiso de lectura del proceso' })
  async pdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser, @Res() response: Response) {
    const file = await this.engine.download(id, 'pdf', actor.id);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.send(file.body);
  }

  @Get(':id/docx')
  @ApiOperation({ summary: 'Descargar el DOCX, con el permiso de lectura del proceso' })
  async docx(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser, @Res() response: Response) {
    const file = await this.engine.download(id, 'docx', actor.id);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.send(file.body);
  }
}
