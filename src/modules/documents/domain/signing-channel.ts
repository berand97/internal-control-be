import { ErrorCode } from '../../../common/constants/error-code.enum.js';

/**
 * Caminos de firma (decisión del producto, Ley 527/1999 y Decreto 2364/2012):
 *
 * | Turno / persona                                     | Camino                                         |
 * |-----------------------------------------------------|------------------------------------------------|
 * | Rol de Control Interno (AUDITA, CONTROL_INTERNO)    | Sesión con MFA, obligatoria                    |
 * | Otro rol, persona con usuario activo                | Sesión (con o sin MFA), rúbrica en canvas      |
 * | Otro rol, persona sin usuario activo                | Enlace de un solo uso al correo institucional  |
 *
 * El método con el que se firmó queda como evidencia por firmante (SESSION_MFA, SESSION, EMAIL_LINK).
 */
export const SIGNATURE_METHODS = ['SESSION_MFA', 'SESSION', 'EMAIL_LINK'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

export const SIGNATURE_METHOD_LABELS: Readonly<Record<SignatureMethod, string>> = {
  SESSION_MFA: 'Sesión con verificación en dos pasos',
  SESSION: 'Sesión',
  EMAIL_LINK: 'Enlace de un solo uso enviado al correo institucional',
};

export const methodLabel = (method: string | null | undefined): string | null =>
  method && method in SIGNATURE_METHOD_LABELS ? SIGNATURE_METHOD_LABELS[method as SignatureMethod] : null;

/** Roles de turno de Control Interno: siempre firman con sesión y MFA. */
export const MFA_REQUIRED_ROLES: ReadonlyArray<string> = ['AUDITA', 'CONTROL_INTERNO'];

export const requiresMfa = (role: string): boolean => MFA_REQUIRED_ROLES.includes(role);

/** Vigencia del enlace desde que se emite su token (al enviarlo). */
export const SIGNING_LINK_TTL_HOURS = 72;
/** Intentos fallidos de confirmar identidad: al quinto el enlace queda invalidado. */
export const MAX_IDENTITY_ATTEMPTS = 5;
/** Vigencia de la autorización que devuelve la confirmación de identidad. */
export const IDENTITY_AUTHORIZATION_MINUTES = 10;
/** Intentos automáticos del outbox de correo; después queda FAILED y visible hasta que se reenvíe. */
export const MAX_LINK_SEND_ATTEMPTS = 3;
/** Espera mínima antes de reintentar un envío (también evita que dos pasadas del job tomen el mismo enlace). */
export const LINK_SEND_RETRY_MINUTES = 5;

/** Los últimos 4 dígitos del número de documento; null si no hay 4 dígitos con qué confirmar identidad. */
export const lastFourDigits = (documentNumber: string | null | undefined): string | null => {
  const digits = (documentNumber ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

export interface SignerCandidate {
  readonly personId: string;
  readonly personActive: boolean;
  readonly email: string | null;
  readonly documentNumber: string | null;
  /** app_user.status; null si la persona no tiene usuario. */
  readonly userStatus: string | null;
  readonly mfaEnabled: boolean;
}

export const TURN_BLOCKERS = [
  ErrorCode.SignatureSignerUnassigned,
  ErrorCode.SignatureSignerInactive,
  ErrorCode.SignatureNoChannel,
  ErrorCode.SignatureNoIdentityCheck,
  ErrorCode.SignatureMfaRequired,
] as const;
export type TurnBlocker = (typeof TURN_BLOCKERS)[number];

export interface TurnChannel {
  /** Camino por el que firma la persona; null si el turno está bloqueado. */
  readonly channel: SignatureMethod | null;
  readonly blockedBy: TurnBlocker | null;
}

export const channelFor = (role: string, candidate: SignerCandidate | null | undefined): TurnChannel => {
  if (!candidate) {
    return { channel: null, blockedBy: ErrorCode.SignatureSignerUnassigned };
  }
  if (!candidate.personActive) {
    return { channel: null, blockedBy: ErrorCode.SignatureSignerInactive };
  }
  const hasUser = candidate.userStatus === 'ACTIVE';
  if (requiresMfa(role)) {
    if (!hasUser) {
      return { channel: null, blockedBy: ErrorCode.SignatureNoChannel };
    }
    return candidate.mfaEnabled
      ? { channel: 'SESSION_MFA', blockedBy: null }
      : { channel: null, blockedBy: ErrorCode.SignatureMfaRequired };
  }
  if (hasUser) {
    return { channel: candidate.mfaEnabled ? 'SESSION_MFA' : 'SESSION', blockedBy: null };
  }
  if (!candidate.email?.trim()) {
    return { channel: null, blockedBy: ErrorCode.SignatureNoChannel };
  }
  if (!lastFourDigits(candidate.documentNumber)) {
    return { channel: null, blockedBy: ErrorCode.SignatureNoIdentityCheck };
  }
  return { channel: 'EMAIL_LINK', blockedBy: null };
};

/** "Laura Responsable Pérez" → "Laura R. P.": la página pública no muestra el nombre completo. */
export const maskName = (name: string | null | undefined): string | null => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const [first, ...rest] = parts;
  return [first, ...rest.map((part) => `${part.charAt(0).toUpperCase()}.`)].join(' ');
};
