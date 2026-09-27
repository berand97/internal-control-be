import { Controller, Get, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { BoundedFileInterceptor, UPLOAD_LIMITS } from '../../shared/storage/uploads/bounded-file.interceptor.js';
import { EmailAssetResponseDto, ListEmailAssetsQueryDto } from './dto/email-asset.responses.js';
import { envelopedArraySchema } from './dto/email-template.responses.js';
import { EmailAssetUploadsService, type EmailAssetUpload } from './email-asset-uploads.service.js';
import { EmailAssetsService } from './email-assets.service.js';

/** Imágenes de las plantillas de correo: subir (manage) y listar para el selector (read). Bajo el módulo Correo. */
@ApiTags(OpenApiTag.Mail)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, EmailAssetResponseDto)
@Feature('mail')
@Controller('email-templates/assets')
export class EmailAssetsController {
  constructor(
    private readonly uploads: EmailAssetUploadsService,
    private readonly assets: EmailAssetsService,
  ) {}

  @Post()
  @RequirePermission('email_template:manage:global')
  @UseInterceptors(BoundedFileInterceptor('file', UPLOAD_LIMITS.EMAIL_IMAGE))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'PNG o JPEG, máximo 1 MB y 2000 × 2000 px' } },
    },
  })
  @ApiOperation({
    summary: 'Subir una imagen para las plantillas de correo',
    description:
      'Se valida por los bytes (no por la extensión ni el tipo declarado): solo PNG o JPEG, máximo 1 MB (FILE_TOO_LARGE) y 2000 × 2000 px (EMAIL_ASSET_INVALID_IMAGE); otro formato (SVG, GIF, HTML renombrado...): FILE_TYPE_NOT_ALLOWED. Se re-codifica sin metadatos (EXIF/GPS) y a lo sumo 1200 px de ancho y se guarda en el bucket de imágenes del proveedor S3 (images/email/<uuid>.<png|jpg>, la única carpeta de lectura anónima); url es su dirección pública. Sin almacenamiento S3 con bucket de imágenes y URL base configurados: 409 PUBLIC_ASSETS_NOT_CONFIGURED. La misma imagen (mismo contenido guardado) devuelve la existente. Las imágenes no se borran.',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(EmailAssetResponseDto) })
  @ApiBadRequestResponse({
    description: 'FILE_TOO_LARGE, FILE_TYPE_NOT_ALLOWED, EMAIL_ASSET_INVALID_IMAGE',
    schema: errorEnvelopeSchema(),
  })
  @ApiConflictResponse({
    description: 'PUBLIC_ASSETS_NOT_CONFIGURED: falta el driver S3, el bucket público o su URL base',
    schema: errorEnvelopeSchema(),
  })
  upload(
    @UploadedFile() file: EmailAssetUpload | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmailAssetResponseDto> {
    if (!file?.buffer) {
      throw new ApiException(ErrorCode.FileTypeNotAllowed, 'Adjunte la imagen en el campo file');
    }
    return this.uploads.upload(file, actor.id);
  }

  @Get()
  @RequirePermission('email_template:read:global')
  @ApiOperation({ summary: 'Imágenes subidas, de la más nueva a la más vieja (selector del editor)' })
  @ApiOkResponse({ schema: envelopedArraySchema(EmailAssetResponseDto) })
  list(@Query() query: ListEmailAssetsQueryDto): Promise<ReadonlyArray<EmailAssetResponseDto>> {
    return this.assets.list(query.limit);
  }
}
