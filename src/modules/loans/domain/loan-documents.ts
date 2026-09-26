/**
 * Actas del préstamo en el motor de documentos. document.entity_type / document_request.payload.entityType de las
 * actas de entrega y de devolución; ningún otro proceso registra 'LOAN' en DocumentLifecycleRegistry.
 */
export const LOAN_DOCUMENT_ENTITY = 'LOAN';

/** Acta de préstamo temporal de activos fijos: ENTREGA → RECIBE → Control Interno (AUDITA). */
export const LOAN_DELIVERY_FORMAT = 'OCI-01-65';

/**
 * Acta de devolución: formato SGC propio que la universidad aún no emite (clave interna LOAN_RETURN, sembrado sin
 * código ni firmantes en document_format_version). Mientras su versión vigente no esté lista, receiveReturn registra la
 * devolución y el préstamo expone el acta como PENDING_FORMAT; cuando Control Interno le cree por API una versión con
 * código y firmantes (POST /documents/formats/LOAN_RETURN/versions), receiveReturn la encola en su transacción con los
 * movimientos RETURN enlazados. Contrato de marcadores en documents/domain/document-formats.ts.
 */
export const LOAN_RETURN_FORMAT = 'LOAN_RETURN';
