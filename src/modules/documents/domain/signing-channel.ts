import { ErrorCode } from '../../../common/constants/error-code.enum.js';

export const SIGNATURE_METHODS = ['SESSION_MFA', 'SESSION', 'EMAIL_LINK'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

export const SIGNATURE_METHOD_LABELS: Readonly<Record<SignatureMethod, string>> = {
  SESSION_MFA: 'Sesión con verificación en dos pasos',
  SESSION: 'Sesión',
  EMAIL_LINK: 'Enlace de un solo uso enviado al correo institucional',
};

export const methodLabel = (method: string | null | undefined): string | null =>
  method && method in SIGNATURE_METHOD_LABELS ? SIGNATURE_METHOD_LABELS[method as SignatureMethod] : null;

export const MFA_REQUIRED_ROLES: ReadonlyArray<string> = ['AUDITA', 'CONTROL_INTERNO'];

export const requiresMfa = (role: string): boolean => MFA_REQUIRED_ROLES.includes(role);

export const SIGNING_LINK_TTL_HOURS = 72;
export const MAX_IDENTITY_ATTEMPTS = 5;
export const IDENTITY_AUTHORIZATION_MINUTES = 10;
export const MAX_LINK_SEND_ATTEMPTS = 3;
export const LINK_SEND_RETRY_MINUTES = 5;

export const lastFourDigits = (documentNumber: string | null | undefined): string | null => {
  const digits = (documentNumber ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

export interface SignerCandidate {
  readonly personId: string;
  readonly personActive: boolean;
  readonly email: string | null;
  readonly documentNumber: string | null;
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

export const maskName = (name: string | null | undefined): string | null => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const [first, ...rest] = parts;
  return [first, ...rest.map((part) => `${part.charAt(0).toUpperCase()}.`)].join(' ');
};
