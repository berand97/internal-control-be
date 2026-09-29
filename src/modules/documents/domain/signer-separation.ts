import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { ErrorDetail } from '../../../common/types/response-envelope.type.js';
import type { SignerSpec } from './document-formats.js';
import { MFA_REQUIRED_ROLES } from './signing-channel.js';

/**
 * Separación de funciones en las actas (todas: entrega OCI-01-55, préstamo OCI-01-65, traslado OCI-17-89, toma física
 * OCI-21-37 y cualquier formato administrable).
 *
 * Una misma persona no puede ocupar dos o más firmas del acta. Excepción: el conflicto incluye un turno de Control
 * Interno (AUDITA o CONTROL_INTERNO) y quien genera el acta designa un SUSTITUTO para ese turno
 * (payload.signerSubstitutions[ROL] = { personId, reason }):
 * - solo se sustituyen turnos de Control Interno (SUBSTITUTABLE_ROLES); un conflicto entre otros roles (Entrega y
 *   Recibe, por ejemplo) no tiene sustituto: hay que cambiar el firmante;
 * - el sustituto tiene usuario activo con el permiso vigente act:sign_control:global («Firmar actas por Control
 *   Interno», CONTROL_SIGNER_PERMISSION; lo comprueba el motor contra v_user_effective_permissions) y no firma ninguna
 *   otra parte del acta. Decide el permiso, nunca el nombre del rol;
 * - la sustitución solo se acepta para resolver un problema real del turno: el designado ocupa otra firma, o no tiene
 *   el permiso act:sign_control:global vigente (p. ej. quien aprobó la conciliación de una toma física, AUDITA);
 * - motivo obligatorio de 3 a 500 caracteres.
 * La sustitución queda impresa en el acta (firmantes[].sustituye, firmante.<rol>.sustitucion.*, tablas.sustituciones)
 * y registrada en document_signature_reassignment con source = 'AT_ISSUE'.
 */
export const SUBSTITUTABLE_ROLES: ReadonlyArray<string> = MFA_REQUIRED_ROLES;

/**
 * Regla del firmante de Control Interno (decisión del desarrollador: «una regla que se aplica en un camino y no en
 * otro no es una regla»). Todo turno cuyo rol es de Control Interno (AUDITA, CONTROL_INTERNO) lo ocupa una persona
 * activa con usuario ACTIVE y el permiso vigente act:sign_control:global, en todos los documentos y caminos: al emitir
 * (DocumentEngineService.signersFor, que usan enqueue, generateWithin y assertSigners de cada proceso) y al reasignar
 * (reassignSigner). Los demás turnos (RESPONSIBLE o REQUEST de otro rol) exigen persona activa con un camino de firma
 * (domain/signing-channel.ts). Error: 400 DOCUMENT_SIGNER_NOT_ELIGIBLE con el rol del turno en details.
 */
export const CONTROL_SIGNER_ROLES: ReadonlyArray<string> = SUBSTITUTABLE_ROLES;

export const requiresControlSigner = (role: string): boolean => CONTROL_SIGNER_ROLES.includes(role);

/**
 * «Firmar actas por Control Interno» (migración 1767225940000): quién puede ser sustituto de un turno de Control
 * Interno y quién firma el turno CONTROL_INTERNO del traslado. Exige MFA (auth/services/mfa-policy.ts).
 */
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
  /** Persona que firma el turno (el sustituto si lo hay). */
  readonly personId: string | null;
  /** Persona designada originalmente y motivo, solo si el turno se sustituyó. */
  readonly substitution: { readonly replacedPersonId: string; readonly reason: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[A-Z][A-Z0-9_]{0,39}$/;

const invalid = (field: string, message: string): never => {
  throw new ApiException(ErrorCode.DocumentSignerSubstituteInvalid, message, [{ field, message }]);
};

/** Forma de payload.signerSubstitutions (viene del cliente o del proceso). Devuelve el mapa con motivos recortados. */
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

/** Persona designada en cada turno según su origen (RESPONSIBLE → responsiblePersonId, REQUEST → signers[ROL]). */
export const designatedSigners = (
  specs: ReadonlyArray<SignerSpec>,
  payload: { readonly responsiblePersonId?: string; readonly signers?: Readonly<Record<string, string>> },
): Array<{ readonly spec: SignerSpec; readonly personId: string | null }> =>
  specs.map((spec) => ({
    spec,
    personId: spec.source === 'RESPONSIBLE' ? (payload.responsiblePersonId ?? null) : (payload.signers?.[spec.role] ?? null),
  }));

/** Grupos de turnos que ocupa una misma persona (solo personas con dos o más turnos). */
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

/**
 * Aplica las sustituciones y exige la separación de funciones. No consulta la BD: que el sustituto tenga el permiso
 * vigente lo comprueba el motor (DocumentEngineService.assertSubstitutesEligible).
 * Errores: DOCUMENT_SIGNER_SUBSTITUTE_INVALID (sustitución mal formada, rol no sustituible, sin conflicto que
 * resolver, sustituto que ya firma otra parte) y DOCUMENT_SIGNER_DUPLICATED (queda una persona en dos firmas; los
 * details nombran los turnos y, si uno es de Control Interno, el campo signerSubstitutions.<ROL> donde va el sustituto).
 */
export const resolveSigners = (
  specs: ReadonlyArray<SignerSpec>,
  payload: {
    readonly responsiblePersonId?: string;
    readonly signers?: Readonly<Record<string, string>>;
    readonly signerSubstitutions?: unknown;
  },
  /** Turnos de Control Interno cuyo designado no tiene el permiso vigente (lo calcula el motor contra la BD). */
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
