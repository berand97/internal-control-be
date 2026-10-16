export const MAIL_OUTBOX_STATUSES = ['PENDING_SEND', 'SENT', 'FAILED'] as const;
export type MailOutboxStatus = (typeof MAIL_OUTBOX_STATUSES)[number];
