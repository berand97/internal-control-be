/**
 * Vigencia de la contraseña temporal de una invitación (BE-14): 72 horas desde que se envía o reenvía.
 *
 * Por qué 72 h: la invitación se manda en horario laboral y el invitado puede no verla hasta el siguiente día
 * hábil; 72 h cubren un envío de viernes por la tarde hasta el lunes por la tarde. Más allá de eso, un correo con una
 * credencial olvidado en el buzón (o reenviado) es una ventana de toma de cuenta sin beneficio: si vence, el
 * administrador la reenvía (POST /users/:id/resend-invitation), lo que genera otra contraseña y renueva el plazo.
 * Es la misma cifra que sugiere la auditoría.
 */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export const invitationExpiryFrom = (now: Date): Date =>
  new Date(now.getTime() + INVITATION_TTL_MS);

/** null = la cuenta no tiene una contraseña temporal con plazo (no es una invitación). */
export const isInvitationExpired = (
  expiresAt: Date | null,
  now: Date,
): boolean => expiresAt !== null && expiresAt.getTime() <= now.getTime();
