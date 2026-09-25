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
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  envelopedSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import {
  CreateLoanDto,
  DeliverLoanDto,
  ExtendLoanDto,
  QueryLoansDto,
  RejectLoanDto,
  ReturnLoanDto,
} from './dto/loan.dto.js';
import {
  LOAN_RESPONSE_MODELS,
  LoanDetailDto,
  LoanListResponseDto,
  LoanSummaryDto,
} from './dto/loan.responses.js';
import { LoansService } from './services/loans.service.js';

const APPROVAL_RULE =
  'Requiere loan:approve:global, o loan:approve:org_unit asignado con alcance COST_CENTER sobre el centro de costo de ORIGEN del préstamo. ' +
  'Sin ninguno: 403 INSUFFICIENT_PERMISSIONS; con el acotado pero sin centros: 403 SCOPE_NO_COST_CENTER / SCOPE_ORG_UNIT_UNRESOLVED; ' +
  'préstamo de otro centro: 404 RESOURCE_NOT_FOUND, igual que uno inexistente. Quien lo solicitó no lo aprueba ni lo rechaza (403 LOAN_SOD_VIOLATION).';

@ApiTags(OpenApiTag.Loans)
@ApiBearerAuth()
@ApiExtraModels(ApiErrorEnvelope, ...LOAN_RESPONSE_MODELS)
@Feature('loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get('overdue')
  @RequirePermission('loan:read:global')
  @ApiOperation({
    summary: 'Alertas de préstamos vencidos',
    description:
      'ACTIVE u OVERDUE con la fecha estimada de devolución anterior a hoy (America/Bogota), aunque el job diario aún no los haya marcado. Filtrado y días de atraso en SQL; los más atrasados primero. No envía correos.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(LoanSummaryDto) })
  overdue() {
    return this.loansService.overdue();
  }

  @Get()
  @RequirePermission('loan:read:global')
  @ApiOperation({ summary: 'Listar préstamos' })
  @ApiOkResponse({ schema: envelopedSchema(LoanListResponseDto) })
  list(@Query() query: QueryLoansDto) {
    return this.loansService.list(query);
  }

  @Get(':id')
  @RequirePermission('loan:read:global')
  @ApiOperation({ summary: 'Detalle de un préstamo, con el estado de su acta de entrega' })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.loansService.getById(id);
  }

  @Post()
  @RequirePermission('loan:request:own')
  @ApiOperation({ summary: 'Solicitar préstamo de uno o más activos' })
  @ApiCreatedResponse({ schema: envelopedSchema(LoanDetailDto) })
  create(@Body() dto: CreateLoanDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.loansService.create(dto, actor);
  }

  // Sin @RequirePermission: el alcance depende del centro de origen del préstamo, que el guard no conoce.
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprobar un préstamo', description: APPROVAL_RULE })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.approve(id, actor);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechazar un préstamo', description: APPROVAL_RULE })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
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
  @ApiOperation({
    summary: 'Entregar los activos y encolar el acta OCI-01-65',
    description:
      'En una transacción: activos ON_LOAN con movimiento LOAN, préstamo ACTIVE, evento DELIVERED y el acta en el outbox del motor. ' +
      'Firmantes del acta: ENTREGA (deliveredByPersonId) → RECIBE (persona de contacto del préstamo) → Control Interno (controlInternoPersonId). ' +
      'La generación es asíncrona: deliveryAct dice si está pendiente, fallida (con el error; se reintenta con POST /documents/requests/:requestId/retry), generada o firmada.',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.deliver(id, dto, actor);
  }

  @Post(':id/return')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registrar la devolución: fecha real y condición por activo',
    description:
      'returnedAt es la fecha real (por defecto, ahora): no futura ni anterior a la entrega. Los activos siguen ON_LOAN hasta receive-return.',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
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
  @ApiOperation({
    summary: 'Confirmar recepción de la devolución',
    description:
      'En una transacción: cada activo devuelto sale de ON_LOAN con movimiento RETURN fechado en su fecha real. No genera acta de devolución (pendiente de decisión de Control Interno).',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
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
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.extend(id, dto, actor);
  }
}
