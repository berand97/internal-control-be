import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';
import {
  SUBSTITUTABLE_ROLES,
  SUBSTITUTION_REASON_MAX,
  SUBSTITUTION_REASON_MIN,
  type SignerSubstitution,
} from '../domain/signer-separation.js';

export type SignerSubstitutionsInput = Record<string, SignerSubstitution>;

/**
 * signerSubstitutions en las DTO que generan un acta (entregas, préstamos, toma física, traslados y POST /documents).
 * La forma y las reglas las valida el motor (domain/signer-separation.ts) con DOCUMENT_SIGNER_SUBSTITUTE_INVALID.
 */
export const ApiSignerSubstitutions = () =>
  applyDecorators(
    ApiPropertyOptional({
      type: 'object',
      description:
        `Separación de funciones: si la persona designada para un turno de Control Interno (${SUBSTITUTABLE_ROLES.join(', ')}) ` +
        'ocupa otra firma del acta (409 DOCUMENT_SIGNER_DUPLICATED) o no tiene el permiso vigente act:sign_control:global ' +
        '(400 DOCUMENT_SIGNER_NOT_ELIGIBLE, details signers.<ROL>), el acta se rechaza salvo que aquí venga su sustituto: ' +
        'rol → { personId, reason }. El sustituto necesita usuario activo con el permiso vigente act:sign_control:global (Firmar actas por Control Interno) ' +
        'y no puede firmar otra parte del acta (400 DOCUMENT_SIGNER_SUBSTITUTE_INVALID). La sustitución queda impresa en el acta.',
      additionalProperties: {
        type: 'object',
        required: ['personId', 'reason'],
        properties: {
          personId: { type: 'string', format: 'uuid', description: 'Persona sustituta' },
          reason: {
            type: 'string',
            minLength: SUBSTITUTION_REASON_MIN,
            maxLength: SUBSTITUTION_REASON_MAX,
            description: 'Motivo de la sustitución (queda en el acta)',
          },
        },
      },
      example: { AUDITA: { personId: '00000000-0000-4000-8000-000000000000', reason: 'La auditora es quien recibe los activos' } },
    }),
    IsOptional(),
    IsObject(),
  );
