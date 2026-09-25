/**
 * Actas del préstamo en el motor de documentos. document.entity_type / document_request.payload.entityType del
 * acta de entrega; ningún otro proceso registra 'LOAN' en DocumentLifecycleRegistry.
 */
export const LOAN_DOCUMENT_ENTITY = 'LOAN';

/** Acta de préstamo temporal de activos fijos: ENTREGA → RECIBE → Control Interno (AUDITA). */
export const LOAN_DELIVERY_FORMAT = 'OCI-01-65';

/*
 * Punto de extensión BLOQUEADO — acta de devolución.
 * El OCI-01-65 institucional es UNA sola acta con la sección "Registro de devolución: Fecha / Estado" en blanco y
 * no existe un formato SGC de devolución aparte (LOAN_RETURN_ACT era del catálogo viejo). Cómo se documenta la
 * devolución sobre un acta ya firmada electrónicamente (¿segunda OCI-01-65 con otro consecutivo?, ¿mismo
 * número?, ¿otro formato?) lo decide Control Interno. Mientras tanto la devolución queda en datos
 * (asset_loan_item.return_condition / returned_at, asset_loan.actual_return_date), en el evento RECEIVED del
 * préstamo y en los movimientos RETURN. Cuando se decida, receiveReturn encola el acta con
 * DocumentEngineService.enqueue(manager, …) dentro de su transacción, igual que deliver.
 */
