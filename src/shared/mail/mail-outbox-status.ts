/** Estados de una fila de mail_outbox (CHECK chk_mail_outbox_status). Archivo aparte: lo importan los DTO. */
export const MAIL_OUTBOX_STATUSES = ['PENDING_SEND', 'SENT', 'FAILED'] as const;
export type MailOutboxStatus = (typeof MAIL_OUTBOX_STATUSES)[number];
