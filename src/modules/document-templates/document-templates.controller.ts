import {
  Controller,
  Get,
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
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  DOCUMENT_TYPES,
  type DocumentType,
} from './domain/placeholder-catalog.js';
import { DocumentTemplatesService } from './services/document-templates.service.js';

interface DocxUpload {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

@ApiTags(OpenApiTag.DocumentTemplates)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope)
@Feature('document-templates')
@Controller('document-templates')
export class DocumentTemplatesController {
  constructor(private readonly templatesService: DocumentTemplatesService) {}

  @Get('catalog')
  @RequirePermission('document_template:read:global')
  @ApiOperation({ summary: 'Catálogo de placeholders por tipo de documento' })
  catalog() {
    return this.templatesService.catalog();
  }

  @Get()
  @RequirePermission('document_template:read:global')
  @ApiOperation({ summary: 'Listar versiones de plantillas Word' })
  list(@Query('documentType') documentType?: string) {
    const typed = DOCUMENT_TYPES.find((item) => item === documentType);
    return this.templatesService.list(typed);
  }

  @Post()
  @RequirePermission('document_template:update:global')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentType'],
      properties: {
        documentType: { type: 'string', enum: [...DOCUMENT_TYPES] },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Subir un Word y activarlo como plantilla' })
  upload(
    @Query('documentType') documentType: DocumentType,
    @UploadedFile() file: DocxUpload | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file?.buffer) {
      throw new ApiException(ErrorCode.FileTypeNotAllowed);
    }
    return this.templatesService.upload(documentType, file, actor);
  }

  @Post(':id/activate')
  @RequirePermission('document_template:update:global')
  @ApiOperation({ summary: 'Activar una versión anterior de plantilla' })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.templatesService.activate(id, actor);
  }
}
