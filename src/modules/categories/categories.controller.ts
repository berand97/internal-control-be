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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { QueryCategoriesDto } from './dto/query-categories.dto.js';
import { CategoryTreeResponseDto } from './dto/responses/category-tree.response.dto.js';
import { CategoryResponseDto } from './dto/responses/category.response.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';
import { CategoriesService } from './services/categories.service.js';

@ApiTags(OpenApiTag.Categories)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  CategoryResponseDto,
  CategoryTreeResponseDto,
)
@Feature('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get('tree')
  @RequirePermission('category:read:global')
  @ApiOperation({ summary: 'Árbol de categorías' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CategoryTreeResponseDto) })
  tree(): Promise<ReadonlyArray<CategoryTreeResponseDto>> {
    return this.categoriesService.tree();
  }

  @Get()
  @RequirePermission('category:read:global')
  @ApiOperation({ summary: 'Listar y buscar categorías' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CategoryResponseDto) })
  list(
    @Query() query: QueryCategoriesDto,
  ): Promise<ReadonlyArray<CategoryResponseDto>> {
    return this.categoriesService.list(query);
  }

  @Get(':id')
  @RequirePermission('category:read:global')
  @ApiOperation({ summary: 'Detalle de categoría' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CategoryResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CategoryResponseDto> {
    return this.categoriesService.getById(id);
  }

  @Post()
  @RequirePermission('category:manage:global')
  @ApiOperation({ summary: 'Crear categoría' })
  @ApiResponse({ status: 201, schema: envelopedSchema(CategoryResponseDto) })
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CategoryResponseDto> {
    return this.categoriesService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('category:manage:global')
  @ApiOperation({
    summary: 'Actualizar categoría',
    description:
      'Cambiar depreciationYears no recalcula depreciaciones ya registradas.',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(CategoryResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CategoryResponseDto> {
    return this.categoriesService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('category:manage:global')
  @ApiOperation({ summary: 'Desactivar categoría (soft delete)' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.categoriesService.remove(id, user);
  }
}
