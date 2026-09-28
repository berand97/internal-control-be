import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { CONTROL_SIGNER_ROLE_CODES, TRANSFER_SIGN_ACCOUNTING } from '../domain/transfer.js';
import type { TransferSignerCandidateDto, TransferWarningDto } from '../dto/transfer.responses.js';

export type TransferSignerKind = 'CONTROL' | 'ACCOUNTING';

const FIELD: Record<TransferSignerKind, string> = {
  CONTROL: 'controlSignerPersonId',
  ACCOUNTING: 'accountingSignerPersonId',
};

const LABEL: Record<TransferSignerKind, string> = {
  CONTROL: 'Control Interno',
  ACCOUNTING: 'Contabilidad',
};

/**
 * Quién puede firmar los turnos del OCI-17-89 que no nombra el traslado (decisión del desarrollador):
 * - CONTABILIDAD: usuario ACTIVE, persona activa, con transfer:sign_accounting:global vigente
 *   (v_user_effective_permissions: asignaciones sin revocar, dentro de su vigencia, con herencia de roles). Lo da el
 *   rol CONTABILIDAD (migración 1767225920000), que el SUPER_ADMIN otorga.
 * - CONTROL_INTERNO: usuario ACTIVE, persona activa, con rol vigente INTERNAL_CONTROL_DIRECTOR o AUDITOR (mismo
 *   criterio que el sustituto de Control Interno del motor).
 * Al generar: una sola persona elegible → se toma sola; varias → el cliente dice cuál (debe estar entre ellas);
 * ninguna → TRANSFER_NO_ACCOUNTING_SIGNER / TRANSFER_NO_CONTROL_SIGNER.
 */
@Injectable()
export class TransferSignersService {
  constructor(private readonly dataSource: DataSource) {}

  async candidates(kind: TransferSignerKind, manager: EntityManager = this.dataSource.manager): Promise<TransferSignerCandidateDto[]> {
    const rows =
      kind === 'ACCOUNTING'
        ? await manager.query(
            `SELECT DISTINCT p.id AS "personId", trim(p.first_name || ' ' || p.last_name) AS name
             FROM v_user_effective_permissions v
             JOIN app_user u ON u.id = v.user_id AND u.status = 'ACTIVE'
             JOIN person p ON p.id = u.person_id AND p.is_active
             WHERE v.permission_code = $1
             ORDER BY name, "personId"`,
            [TRANSFER_SIGN_ACCOUNTING],
          )
        : await manager.query(
            `SELECT DISTINCT p.id AS "personId", trim(p.first_name || ' ' || p.last_name) AS name
             FROM app_user u
             JOIN person p ON p.id = u.person_id AND p.is_active
             JOIN user_role ur ON ur.user_id = u.id AND ur.revoked_at IS NULL AND ur.valid_from <= NOW()
               AND (ur.valid_until IS NULL OR ur.valid_until > NOW())
             JOIN role r ON r.id = ur.role_id AND r.deleted_at IS NULL
             WHERE u.status = 'ACTIVE' AND r.code = ANY($1::text[])
             ORDER BY name, "personId"`,
            [CONTROL_SIGNER_ROLE_CODES],
          );
    return rows as TransferSignerCandidateDto[];
  }

  /** La persona que firmará el turno, según la regla de arriba. */
  async resolve(kind: TransferSignerKind, requested: string | undefined, manager: EntityManager): Promise<string> {
    const candidates = await this.candidates(kind, manager);
    if (candidates.length === 0) {
      throw new ApiException(kind === 'ACCOUNTING' ? ErrorCode.TransferNoAccountingSigner : ErrorCode.TransferNoControlSigner);
    }
    if (requested) {
      if (!candidates.some((candidate) => candidate.personId === requested)) {
        throw new ApiException(
          ErrorCode.TransferSignerNotEligible,
          kind === 'ACCOUNTING'
            ? 'La persona indicada no tiene el rol de Contabilidad (transfer:sign_accounting:global) vigente'
            : 'La persona indicada no tiene rol vigente de Dirección de Control Interno o Auditor',
          [{ field: FIELD[kind], message: `No puede firmar por ${LABEL[kind]}` }],
        );
      }
      return requested;
    }
    const [only, ...others] = candidates;
    if (!only || others.length > 0) {
      throw new ApiException(
        ErrorCode.TransferSignerRequired,
        `Hay ${candidates.length} personas que pueden firmar por ${LABEL[kind]}: indique ${FIELD[kind]}`,
        [{ field: FIELD[kind], message: `Elija entre ${candidates.length} personas` }],
      );
    }
    return only.personId;
  }

  /** Avisos para la pantalla (detalle y creación del traslado): sin firmante posible, el acta no se puede generar. */
  async availability(manager: EntityManager = this.dataSource.manager): Promise<{
    readonly controlSignerAvailable: boolean;
    readonly accountingSignerAvailable: boolean;
    readonly warnings: TransferWarningDto[];
  }> {
    const control = (await this.candidates('CONTROL', manager)).length > 0;
    const accounting = (await this.candidates('ACCOUNTING', manager)).length > 0;
    return {
      controlSignerAvailable: control,
      accountingSignerAvailable: accounting,
      warnings: [
        ...(control
          ? []
          : [
              {
                code: 'NO_CONTROL_SIGNER' as const,
                message:
                  'No hay ningún usuario con rol de Dirección de Control Interno o Auditor que firme por Control Interno: el acta no se podrá generar. Pídele al administrador que lo asigne',
              },
            ]),
        ...(accounting
          ? []
          : [
              {
                code: 'NO_ACCOUNTING_SIGNER' as const,
                message:
                  'No hay ningún usuario con el rol de Contabilidad: el acta no se podrá generar. Pídele al administrador que lo asigne',
              },
            ]),
      ],
    };
  }
}
