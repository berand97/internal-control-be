import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { IDENTITY_DOCUMENT_TYPE_CODES, IDENTITY_DOCUMENT_TYPES } from '../../common/identity/identity-document-types.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import { IdentityDocumentTypeDto } from './dto/cost-center-head.dto.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { PersonDirectoryResponseDto, QueryPersonDirectoryDto } from './dto/person-directory.dto.js';
import { PERSON_DIRECTORY_PERMISSIONS, PersonDirectoryService } from './services/person-directory.service.js';

@ApiTags(OpenApiTag.Users)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, PersonDirectoryResponseDto, IdentityDocumentTypeDto)
@Controller('persons')
export class PersonsController {
  constructor(private readonly directory: PersonDirectoryService) {}

  @Get('document-types')
  @ApiOperation({
    summary: 'Catálogo de tipos de documento de identidad',
    description:
      'Código que se guarda en la persona y abreviatura que imprimen las actas. C.C. viene del formato institucional; las demás abreviaturas están pendientes de confirmación por Control Interno.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(IdentityDocumentTypeDto) })
  documentTypes(): IdentityDocumentTypeDto[] {
    return IDENTITY_DOCUMENT_TYPE_CODES.map((code) => ({
      code,
      label: IDENTITY_DOCUMENT_TYPES[code].label,
      abbreviation: IDENTITY_DOCUMENT_TYPES[code].abbreviation,
    }));
  }

  @Get()
  @ApiOperation({
    summary: 'Buscar personas para asignarlas a un acta (quién recibe, quién firma, reasignación de turnos)',
    description: `Solo lectura, solo personas activas. Requiere alguno de: ${PERSON_DIRECTORY_PERMISSIONS.join(', ')}. search busca en el nombre completo y por prefijo del documento. hasActiveUser y mfaEnabled dicen si la persona podrá firmar su turno.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(PersonDirectoryResponseDto) })
  async list(@Query() query: QueryPersonDirectoryDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.directory.assertCanRead(actor.id);
    return this.directory.search({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.search ? { search: query.search } : {}),
    });
  }
}
