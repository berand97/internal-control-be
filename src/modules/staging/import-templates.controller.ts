import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { ApiSuccessEnvelope } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import { ImportTemplateDto } from './dto/import.responses.js';
import { IMPORT_TARGETS, type ImportTarget } from './import/import-fields.js';
import { XLSX_MIME } from './templates/import-template.js';
import { type ImportTemplateRecord, ImportTemplateService } from './templates/import-template.service.js';

/**
 * Plantillas Excel de importación, con el mismo permiso que la importación. El archivo sale del storage del sistema
 * y solo se regenera cuando cambia la definición de campos o un catálogo de los desplegables (ver import-template.ts).
 */
@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ImportTemplateDto)
@Feature('assets')
@Controller('imports/templates')
export class ImportTemplatesController {
  constructor(private readonly templates: ImportTemplateService) {}

  @Get()
  @RequirePermission('asset:create:global')
  @ApiOperation({
    summary: 'Plantillas de importación vigentes (una por destino): versión y fecha, para el botón de descarga',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(ImportTemplateDto) })
  list(@CurrentUser() actor: AuthenticatedUser): Promise<ReadonlyArray<ImportTemplateRecord>> {
    return this.templates.list(actor.id);
  }

  @Get(':target')
  @RequirePermission('asset:create:global')
  @ApiProduces(XLSX_MIME)
  @ApiOkResponse({
    description: 'Archivo .xlsx (Content-Disposition: attachment; filename=plantilla-<destino>-v<versión>.xlsx)',
    content: { [XLSX_MIME]: { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: 'Descargar la plantilla Excel vigente de un destino (ASSETS, COST_CENTERS, PERSONS)',
    description: 'Destino desconocido: 400 VALIDATION_FAILED',
  })
  async download(
    @Param('target') target: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const known = IMPORT_TARGETS.find((item): item is ImportTarget => item === target);
    if (!known) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Destino de importación desconocido');
    }
    const file = await this.templates.download(known, actor.id);
    response.setHeader('Content-Type', XLSX_MIME);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.send(file.body);
  }
}
