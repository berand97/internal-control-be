import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { CreateNavigationItemDto } from './dto/create-navigation-item.dto.js';
import { UpdateNavigationItemDto } from './dto/update-navigation-item.dto.js';
import { NavigationAdminItemResponseDto } from './dto/responses/navigation-admin-item.response.dto.js';
import { NavigationService } from './services/navigation.service.js';

@ApiTags(OpenApiTag.Navigation)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  NavigationAdminItemResponseDto,
)
@Feature('roles')
@Controller('navigation')
export class NavigationController {
  constructor(private readonly navigationService: NavigationService) {}

  @Get()
  @RequirePermission('navigation:manage:global')
  @ApiOperation({
    summary: 'Listar ítems de menú (incluye inactivos)',
    description:
      'Catálogo administrable. La visibilidad por usuario sigue saliendo de sus permisos en /auth/me.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(NavigationAdminItemResponseDto),
  })
  list(): Promise<ReadonlyArray<NavigationAdminItemResponseDto>> {
    return this.navigationService.listAdmin();
  }

  @Post()
  @RequirePermission('navigation:manage:global')
  @ApiOperation({ summary: 'Crear ítem de menú' })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(NavigationAdminItemResponseDto),
  })
  create(
    @Body() dto: CreateNavigationItemDto,
  ): Promise<NavigationAdminItemResponseDto> {
    return this.navigationService.create(dto);
  }

  @Patch(':id')
  @RequirePermission('navigation:manage:global')
  @ApiOperation({ summary: 'Actualizar ítem de menú' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(NavigationAdminItemResponseDto),
  })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateNavigationItemDto,
  ): Promise<NavigationAdminItemResponseDto> {
    return this.navigationService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('navigation:manage:global')
  @ApiOperation({ summary: 'Eliminar ítem de menú' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<null> {
    return this.navigationService.remove(id);
  }
}
