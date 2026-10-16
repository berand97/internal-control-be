import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { ErrorDetail } from '../../../common/types/response-envelope.type.js';
import type { SignerSpec } from './document-formats.js';
import { MFA_REQUIRED_ROLES } from './signing-channel.js';

export const SUBSTITUTABLE_ROLES: ReadonlyArray<string> = MFA_REQUIRED_ROLES;

export const CONTROL_SIGNER_ROLES: ReadonlyArray<string> = SUBSTITUTABLE_ROLES;

export const requiresControlSigner = (role: string): boolean => CONTROL_SIGNER_ROLES.includes(role);

export const CONTROL_SIGNER_PERMISSION = 'act:sign_control:global';

export const SUBSTITUTION_REASON_MIN = 3;
export const SUBSTITUTION_REASON_MAX = 500;

export interface SignerSubstitution {
  readonly personId: string;
  readonly reason: string;
}

export type SignerSubstitutions = Readonly<Record<string, SignerSubstitution>>;

export interface ResolvedSigner {
  readonly spec: SignerSpec;
  readonly personId: string | null;
  readonly substitution: { readonly replacedPersonId: string; readonly reason: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[A-Z][A-Z0-9_]{0,39}$/;

const invalid = (field: string, message: string): never => {
  throw new ApiException(ErrorCode.DocumentSignerSubstituteInvalid, message, [{ field, message }]);
};

export const normalizeSubstitutions = (raw: unknown): SignerSubstitutions => {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('signerSubstitutions', 'Debe ser un objeto rol → { personId, reason }');
  }
  const result: Record<string, SignerSubstitution> = {};
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = `signerSubstitutions.${role.slice(0, 40)}`;
    if (!ROLE.test(role)) {
      invalid(field, 'Rol inválido');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalid(field, 'Debe ser { personId, reason }');
    }
    const { personId, reason } = value as Record<string, unknown>;
    if (typeof personId !== 'string' || !UUID.test(personId)) {
      invalid(`${field}.personId`, 'Persona sustituta inválida');
    }
    const motive = typeof reason === 'string' ? reason.trim() : '';
    if (motive.length < SUBSTITUTION_REASON_MIN || motive.length > SUBSTITUTION_REASON_MAX) {
      invalid(`${field}.reason`, `Motivo de ${SUBSTITUTION_REASON_MIN} a ${SUBSTITUTION_REASON_MAX} caracteres`);
    }
    result[role] = { personId: personId as string, reason: motive };
  }
  return result;
};

export const designatedSigners = (
  specs: ReadonlyArray<SignerSpec>,
  payload: { readonly responsiblePersonId?: string; readonly signers?: Readonly<Record<string, string>> },
): Array<{ readonly spec: SignerSpec; readonly personId: string | null }> =>
  specs.map((spec) => ({
    spec,
    personId: spec.source === 'RESPONSIBLE' ? (payload.responsiblePersonId ?? null) : (payload.signers?.[spec.role] ?? null),
  }));

export const conflictsOf = (
  signers: ReadonlyArray<{ readonly spec: SignerSpec; readonly personId: string | null }>,
): Array<{ readonly personId: string; readonly specs: ReadonlyArray<SignerSpec> }> => {
  const byPerson = new Map<string, SignerSpec[]>();
  for (const signer of signers) {
    if (signer.personId) {
      byPerson.set(signer.personId, [...(byPerson.get(signer.personId) ?? []), signer.spec]);
    }
  }
  return [...byPerson.entries()]
    .filter(([, specs]) => specs.length > 1)
    .map(([personId, specs]) => ({ personId, specs }));
};

const roleList = (specs: ReadonlyArray<SignerSpec>): string => specs.map((spec) => `${spec.label} (${spec.role})`).join(', ');

export const resolveSigners = (
  specs: ReadonlyArray<SignerSpec>,
  payload: {
    readonly responsiblePersonId?: string;
    readonly signers?: Readonly<Record<string, string>>;
    readonly signerSubstitutions?: unknown;
  },
  ineligibleRoles: ReadonlySet<string> = new Set(),
): ResolvedSigner[] => {
  const substitutions = normalizeSubstitutions(payload.signerSubstitutions);
  const designated = designatedSigners(specs, payload);
  const conflicted = new Set(conflictsOf(designated).map((conflict) => conflict.personId));
  for (const [role, substitution] of Object.entries(substitutions)) {
    const field = `signerSubstitutions.${role}`;
    const slot = designated.find((item) => item.spec.role === role);
    if (!slot) {
      invalid(field, `El acta no tiene el turno ${role}`);
    }
    if (!SUBSTITUTABLE_ROLES.includes(role)) {
      invalid(field, `Solo se sustituyen turnos de Control Interno (${SUBSTITUTABLE_ROLES.join(', ')}); ${role} no`);
    }
    if (!slot?.personId || (!conflicted.has(slot.personId) && !ineligibleRoles.has(role))) {
      invalid(
        field,
        `El designado de ${role} no ocupa otra firma del acta y tiene el permiso vigente: no hay nada que resolver con un sustituto`,
      );
    }
    if (substitution.personId === slot?.personId) {
      invalid(`${field}.personId`, 'El sustituto es la misma persona designada');
    }
  }
  const resolved: ResolvedSigner[] = designated.map((item) => {
    const substitution = substitutions[item.spec.role];
    return substitution && item.personId
      ? { spec: item.spec, personId: substitution.personId, substitution: { replacedPersonId: item.personId, reason: substitution.reason } }
      : { spec: item.spec, personId: item.personId, substitution: null };
  });
  for (const signer of resolved.filter((item) => item.substitution)) {
    const other = resolved.find((item) => item !== signer && item.personId === signer.personId);
    if (other) {
      invalid(
        `signerSubstitutions.${signer.spec.role}.personId`,
        `El sustituto de ${signer.spec.label} ya firma el acta como ${other.spec.label} (${other.spec.role})`,
      );
    }
  }
  const remaining = conflictsOf(resolved);
  if (remaining.length > 0) {
    const details: ErrorDetail[] = remaining.flatMap(({ specs: taken }) => {
      const substitutable = taken.filter((spec) => SUBSTITUTABLE_ROLES.includes(spec.role));
      return [
        ...taken.map((spec) => ({
          field: `signers.${spec.role}`,
          message: `La misma persona firma como ${roleList(taken)}`,
        })),
        ...(substitutable.length > 0
          ? substitutable.map((spec) => ({
              field: `signerSubstitutions.${spec.role}`,
              message: `Indique un sustituto para ${spec.label} con el permiso «Firmar actas por Control Interno» vigente, y el motivo`,
            }))
          : [{ field: 'signers', message: `No hay sustituto posible entre ${roleList(taken)}: cambie el firmante` }]),
      ];
    });
    const summary = remaining
      .map(({ specs: taken }) =>
        taken.some((spec) => SUBSTITUTABLE_ROLES.includes(spec.role))
          ? `una misma persona firma como ${roleList(taken)}; indique un sustituto para el turno de Control Interno`
          : `una misma persona firma como ${roleList(taken)}; no hay sustituto posible, cambie el firmante`,
      )
      .join('. ');
    throw new ApiException(ErrorCode.DocumentSignerDuplicated, `Separación de funciones: ${summary}`, details);
  }
  return resolved;
};
