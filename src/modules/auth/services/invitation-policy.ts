export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export const invitationExpiryFrom = (now: Date): Date =>
  new Date(now.getTime() + INVITATION_TTL_MS);

export const isInvitationExpired = (
  expiresAt: Date | null,
  now: Date,
): boolean => expiresAt !== null && expiresAt.getTime() <= now.getTime();
