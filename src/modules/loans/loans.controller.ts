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
  ReceiveReturnDto,
  RegenerateDeliveryActDto,
  RejectLoanDto,
  ReturnLoanDto,
  UndoDeliveryDto,
} from './dto/loan.dto.js';
import {
  LOAN_RESPONSE_MODELS,
  LoanDetailDto,
  LoanListResponseDto,
  LoanSummaryDto,
} from './dto/loan.responses.js';
import { LoansService } from './services/loans.service.js';

const APPROVAL_RULE =
  'Requiere loan:approve:global, o loan:approve:org_unit asignado con alcance COST_CENTER (o jefatura vigente) sobre el centro de costo de ORIGEN del préstamo. ' +
  'Sin ninguno: 403 INSUFFICIENT_PERMISSIONS; con el acotado pero sin centros: 403 SCOPE_NO_COST_CENTER / SCOPE_ORG_UNIT_UNRESOLVED; ' +
  'préstamo de otro centro: 404 RESOURCE_NOT_FOUND, igual que uno inexistente. Quien lo solicitó no lo aprueba ni lo rechaza (403 LOAN_SOD_VIOLATION).';

const READ_RULE =
  'Requiere loan:read:global (todos), o loan:read:org_unit: solo préstamos cuyo centro de ORIGEN o de DESTINO está entre los centros del usuario ' +
  '(asignaciones COST_CENTER vigentes ∪ jefaturas). El filtro va en la consulta. Sin ninguno: 403 INSUFFICIENT_PERMISSIONS; con el acotado pero sin ' +
  'centros: 403 SCOPE_NO_COST_CENTER / SCOPE_ORG_UNIT_UNRESOLVED.';

@ApiTags(OpenApiTag.Loans)
@ApiBearerAuth()
@ApiExtraModels(ApiErrorEnvelope, ...LOAN_RESPONSE_MODELS)
@Feature('loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  // Lecturas sin @RequirePermission: el alcance (global o por centros) lo resuelve el servicio en la consulta.
  @Get('overdue')
  @ApiOperation({
    summary: 'Alertas de préstamos vencidos',
    description:
      'PENDING_SIGNATURES, ACTIVE, OVERDUE o PARTIALLY_RETURNED con la fecha estimada de devolución anterior a hoy (America/Bogota), aunque el job diario aún no los haya marcado. ' +
      'Filtrado y días de atraso en SQL; los más atrasados primero. No envía correos. ' +
      READ_RULE,
  })
  @ApiOkResponse({ schema: envelopedArraySchema(LoanSummaryDto) })
  overdue(@CurrentUser() actor: AuthenticatedUser) {
    return this.loansService.overdue(actor);
  }

  @Get()
  @ApiOperation({ summary: 'Listar préstamos', description: READ_RULE })
  @ApiOkResponse({ schema: envelopedSchema(LoanListResponseDto) })
  list(@Query() query: QueryLoansDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.loansService.list(query, actor);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de un préstamo, con sus actas de entrega y de devolución',
    description: `${READ_RULE} Fuera de alcance: 404 RESOURCE_NOT_FOUND, idéntico a un préstamo inexistente.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.loansService.getById(id, actor);
  }

  @Post()
  @RequirePermission('loan:request:own')
  @ApiOperation({
    summary: 'Solicitar préstamo de uno o más activos a otra dependencia',
    description:
      'El préstamo se otorga a la dependencia de destino (targetCostCenterId); contactPerson es quien recibe y firma, no el nuevo responsable. ' +
      'La disponibilidad se valida dentro de la transacción con las filas de los activos bloqueadas: un activo que ya está en un préstamo abierto ' +
      '(incluida otra solicitud) responde 406 ASSET_ALREADY_LOANED. Origen = destino: 400 LOAN_SAME_COST_CENTER.',
  })
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
      'En una transacción: activos ON_LOAN con movimiento LOAN (la salida física queda registrada al entregar), préstamo PENDING_SIGNATURES, evento DELIVERED y el acta en el outbox. ' +
      'El préstamo pasa a ACTIVE cuando el acta queda firmada. Firmantes: ENTREGA (deliveredByPersonId) → RECIBE (persona de contacto) → Control Interno (controlInternoPersonId). ' +
      'El responsable y el centro de costo de los activos no cambian. deliveryAct dice si el acta está pendiente, fallida, generada, firmada o rechazada.',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.deliver(id, dto, actor);
  }

  @Post(':id/delivery-act/regenerate')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generar una nueva acta OCI-01-65 tras un rechazo',
    description:
      'Solo con el préstamo PENDING_SIGNATURES y el acta vigente REJECTED (si no: 406 INVALID_LOAN_STATE_TRANSITION o 409 LOAN_DELIVERY_ACT_NOT_REJECTED). ' +
      'Permiso de generación del formato (loan:update:global). En una transacción encola otra acta (nuevo consecutivo) con los mismos activos, movimientos y fechas, ' +
      'y los firmantes corregidos; la rechazada queda como registro REJECTED en deliveryAct.previous.',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  regenerateDeliveryAct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegenerateDeliveryActDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.regenerateDeliveryAct(id, dto, actor);
  }

  @Post(':id/undo-delivery')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deshacer la entrega de un préstamo que no va a seguir',
    description:
      'Solo con el préstamo PENDING_SIGNATURES (acta sin firmar). En una transacción: anula el acta (solicitudes CANCELLED, acta VOIDED con el motivo), ' +
      'cada activo vuelve a su estado previo con movimiento RETURN (metadata.undoDelivery) y el préstamo queda CANCELLED. ' +
      'Acta ya firmada: 409 DOCUMENT_ALREADY_SIGNED. Otro estado: 406 INVALID_LOAN_STATE_TRANSITION. Regla provisional: permiso de generación del acta (pendiente de Control Interno).',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  undoDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UndoDeliveryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.undoDelivery(id, dto, actor);
  }

  @Post(':id/return')
  @RequirePermission('loan:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registrar la devolución: fecha real y condición por activo',
    description:
      'Desde ACTIVE u OVERDUE, o desde PARTIALLY_RETURNED para los activos que siguen fuera (devolverlos o declararlos perdidos con LOST). ' +
      'returnedAt es la fecha real (por defecto, ahora): no futura ni anterior a la entrega. Un activo ya recibido: 400. Los activos siguen ON_LOAN hasta receive-return.',
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
      'En una transacción: cada activo registrado sale de ON_LOAN con movimiento RETURN fechado en su fecha real. Resultado: RETURNED, ' +
      'PARTIALLY_RETURNED (quedan activos fuera) o CLOSED_WITH_LOSSES (todo resuelto, alguno perdido). ' +
      'Acta de devolución (LOAN_RETURN): formato institucional aún no emitido, así que la recepción se registra y returnActs[] la muestra PENDING_FORMAT; ' +
      'cuando el catálogo tenga código y firmantes, se encola aquí con returnActSigners.',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  receiveReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveReturnDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.receiveReturn(id, dto, actor);
  }

  @Post(':id/extend')
  @RequirePermission('loan:request:own')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pedir extensión (solo el solicitante)',
    description:
      'Solo quien solicitó el préstamo (si no: 403 LOAN_EXTENSION_NOT_REQUESTER), con el préstamo ACTIVE u OVERDUE y una fecha posterior a la vigente y no pasada (400). ' +
      'Queda en extensionRequestedDate hasta que la apruebe o rechace quien puede aprobar el préstamo.',
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.requestExtension(id, dto, actor);
  }

  @Post(':id/extension/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aprobar la extensión pedida',
    description: `${APPROVAL_RULE} Sin extensión pendiente: 409 LOAN_NO_PENDING_EXTENSION. Un OVERDUE con la nueva fecha no vencida vuelve a ACTIVE.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  approveExtension(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.loansService.approveExtension(id, actor);
  }

  @Post(':id/extension/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rechazar la extensión pedida',
    description: `${APPROVAL_RULE} Sin extensión pendiente: 409 LOAN_NO_PENDING_EXTENSION.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(LoanDetailDto) })
  rejectExtension(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLoanDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.loansService.rejectExtension(id, dto, actor);
  }
}
