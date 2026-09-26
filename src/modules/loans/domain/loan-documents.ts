/**
 * Actas del préstamo en el motor de documentos. document.entity_type / document_request.payload.entityType de las
 * actas de entrega y de devolución; ningún otro proceso registra 'LOAN' en DocumentLifecycleRegistry.
 */
export const LOAN_DOCUMENT_ENTITY = 'LOAN';

/** Acta de préstamo temporal de activos fijos: ENTREGA → RECIBE → Control Interno (AUDITA). */
export const LOAN_DELIVERY_FORMAT = 'OCI-01-65';

/**
 * Acta de devolución: formato SGC propio que la universidad aún no emite (clave interna LOAN_RETURN, sin código ni
 * firmantes en domain/document-formats.ts). Mientras no esté listo, receiveReturn registra la devolución y el
 * préstamo expone el acta como PENDING_FORMAT; cuando el catálogo tenga código y firmantes, receiveReturn la encola
 * en su transacción con los movimientos RETURN enlazados. Contrato de marcadores en document-formats.ts.
 */
export const LOAN_RETURN_FORMAT = 'LOAN_RETURN';
