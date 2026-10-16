import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { ControlSignersService } from '../../documents/services/control-signers.service.js';
import { CONTROL_SIGNER_PERMISSION, TRANSFER_SIGN_ACCOUNTING } from '../domain/transfer.js';
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

const PERMISSION: Record<TransferSignerKind, string> = {
  CONTROL: CONTROL_SIGNER_PERMISSION,
  ACCOUNTING: TRANSFER_SIGN_ACCOUNTING,
};

@Injectable()
export class TransferSignersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly holders: ControlSignersService,
  ) {}

  candidates(kind: TransferSignerKind, manager: EntityManager = this.dataSource.manager): Promise<TransferSignerCandidateDto[]> {
    return this.holders.holders(PERMISSION[kind], manager);
  }

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
            : 'La persona indicada no tiene el permiso «Firmar actas por Control Interno» (act:sign_control:global) vigente',
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
                  'No hay ningún usuario con el permiso «Firmar actas por Control Interno»: el acta no se podrá generar. Pídele al administrador que lo otorgue',
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
