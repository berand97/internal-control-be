import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CreateLoanDto,
  ExtendLoanDto,
  QueryLoansDto,
  RejectLoanDto,
  ReturnLoanDto,
} from './dto/loan.dto.js';
import { LoansService } from './services/loans.service.js';

@ApiTags(OpenApiTag.Loans)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope)
@Feature('loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get('overdue')
  @RequirePermission('loan:read:global')
  @ApiOperation({ summary: 'Préstamos vencidos' })
  overdue() {
    return this.loansService.overdue();
  }

  @Get()
  @RequirePermission('loan:read:global')
  @ApiOperation({ summary: 'Listar préstamos' })
  list(@Query() query: QueryLoansDto) {
    return this.loansService.list(query);
  }

  @Get(':id')
  @RequirePermission('loan:read:global')
  @ApiOperation({ summary: 'Detalle de un préstamo' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.loansService.getById(id);
  }

  @Post()
  @RequirePermission('loan:request:own')
  @ApiOperation({ summary: 'Solicitar préstamo de uno o más activos' })
  create(@Body() dto: CreateLoanDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.loansService.create(dto, actor);
  }

  @Post(':id/approve')
  @RequirePermission('loan:approve:org_unit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprobar un préstamo' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.approve(id, actor);
  }

  @Post(':id/reject')
  @RequirePermission('loan:approve:org_unit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechazar un préstamo' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.reject(id, dto, actor);
  }

  @Post(':id/deliver')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Entregar activos y generar acta Word' })
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.deliver(id, actor);
  }

  @Post(':id/return')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar devolución' })
  startReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.startReturn(id, dto, actor);
  }

  @Post(':id/receive-return')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar recepción de la devolución' })
  receiveReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.receiveReturn(id, actor);
  }

  @Post(':id/extend')
  @RequirePermission('loan:request:own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solicitar o aprobar extensión' })
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.extend(id, dto, actor);
  }
}
