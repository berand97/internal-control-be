import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { Asset } from '../../assets/entities/asset.entity.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { OPERATIONAL_STATUS_PHRASE, OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import { type DocumentLifecycleEvent, DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import {
  WRITE_OFF_ENTITY_TYPE,
  WRITE_OFF_FORMAT_KEY,
  WRITE_OFF_SIGNER_SOURCES,
  type WriteOffItemState,
  writeOffItemReason,
} from '../domain/write-off.js';
import { type WriteOffRow, WriteOffsService } from './write-offs.service.js';

const bogotaDate = (date: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(date);

@Injectable()
export class WriteOffActLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly writeOffs: WriteOffsService,
    private readonly assetState: AssetStateService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: WRITE_OFF_ENTITY_TYPE,
      formats: [{ formatKey: WRITE_OFF_FORMAT_KEY, process: 'Bajas de activos', signers: WRITE_OFF_SIGNER_SOURCES }],
      onGenerated: (manager, event) => this.onGenerated(manager, event),
      onSigned: (manager, event) => this.onSigned(manager, event),
      onRejected: (manager, event) => this.onRejected(manager, event),
    });
  }

  private async lockFor(manager: EntityManager, event: DocumentLifecycleEvent): Promise<WriteOffRow> {
    if (event.formatKey !== WRITE_OFF_FORMAT_KEY) {
      throw new Error(`El acta ${event.number} es ${event.formatKey}, no ${WRITE_OFF_FORMAT_KEY}`);
    }
    if (!event.entityId) {
      throw new Error(`El acta ${event.number} no nombra su baja`);
    }
    return this.writeOffs.lock(manager, event.entityId);
  }

  private async onGenerated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const writeOff = await this.lockFor(manager, event);
    if (writeOff.status !== 'PENDING_SIGNATURES' || writeOff.document_id !== null) {
      throw new Error(`La baja ${writeOff.id} no espera acta (${writeOff.document_id ?? writeOff.status})`);
    }
    await manager.query('UPDATE asset_write_off SET document_id = $2 WHERE id = $1', [writeOff.id, event.documentId]);
  }

  private async onSigned(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const writeOff = await this.lockFor(manager, event);
    if (writeOff.document_id !== event.documentId) {
      throw new Error(`El acta ${event.number} no es la de la baja ${writeOff.id}`);
    }
    if (writeOff.status === 'COMPLETED') {
      return;
    }
    if (writeOff.status !== 'PENDING_SIGNATURES') {
      throw new Error(`La baja ${writeOff.id} está ${writeOff.status}, no pendiente de firmas`);
    }
    const controlPerson = event.signersByRole['CONTROL_INTERNO'] ?? null;
    const [controlUser] = controlPerson
      ? ((await manager.query(`SELECT id FROM app_user WHERE person_id = $1 ORDER BY (status = 'ACTIVE') DESC, id LIMIT 1`, [
          controlPerson,
        ])) as Array<{ id: string }>)
      : [];
    const authorizedBy = controlUser?.id ?? writeOff.created_by;
    const items = (await manager.query(
      'SELECT asset_id AS "assetId", state, notes, movement_id FROM asset_write_off_item WHERE write_off_id = $1 ORDER BY line_number',
      [writeOff.id],
    )) as Array<{ assetId: string; state: WriteOffItemState; notes: string | null; movement_id: string | null }>;
    const writtenOffAt = bogotaDate(new Date());
    for (const { assetId, state, notes } of items.filter((item) => item.movement_id === null)) {
      const reason = writeOffItemReason(state, notes);
      await this.assetState.apply(
        {
          assetId,
          actorId: authorizedBy,
          patch: {
            operationalStatus: OperationalStatus.WrittenOff,
            writtenOffAt,
            writeOffReason: reason,
            writeOffDocument: event.number,
            writeOffApprovedBy: authorizedBy,
          },
          movement: {
            type: MovementType.WriteOff,
            reason: `Acta de baja de activos ${WRITE_OFF_FORMAT_KEY} No. ${event.number}`,
            documentReference: event.number,
            requestedBy: writeOff.created_by,
            metadata: { writeOffId: writeOff.id, documentId: event.documentId, state },
          },
          guard: (current: Asset) => {
            if (current.operationalStatus === OperationalStatus.WrittenOff || current.operationalStatus === OperationalStatus.OnLoan) {
              throw new ApiException(
                ErrorCode.AssetCannotBeModified,
                `El activo ${current.internalCode} está ${OPERATIONAL_STATUS_PHRASE[current.operationalStatus]}.`,
              );
            }
          },
          alsoWrite: async (tx) => {
            const [movement] = (await tx.query(
              `SELECT id FROM asset_movement
               WHERE asset_id = $1 AND movement_type = 'WRITE_OFF' AND metadata->>'writeOffId' = $2 AND metadata->>'documentId' = $3`,
              [assetId, writeOff.id, event.documentId],
            )) as Array<{ id: string }>;
            if (!movement) {
              throw new Error(`No quedó el movimiento de baja del activo ${assetId}`);
            }
            await tx.query('UPDATE asset_write_off_item SET movement_id = $3, open = FALSE WHERE write_off_id = $1 AND asset_id = $2', [
              writeOff.id,
              assetId,
              movement.id,
            ]);
            await tx.query('UPDATE document_asset SET movement_id = $3 WHERE document_id = $1 AND asset_id = $2 AND movement_id IS NULL', [
              event.documentId,
              assetId,
              movement.id,
            ]);
          },
          audit: {
            action: AuditAction.AssetWrittenOff,
            changes: { writeOffId: writeOff.id, documentId: event.documentId, documentReference: event.number, state },
          },
        },
        manager,
      );
    }
    await manager.query(`UPDATE asset_write_off SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [writeOff.id]);
    await manager.query('UPDATE asset_write_off_item SET open = FALSE WHERE write_off_id = $1', [writeOff.id]);
    await this.writeOffs.audit(manager, AuditAction.WriteOffCompleted, writeOff.id, authorizedBy, {
      documentId: event.documentId,
      documentNumber: event.number,
      assets: items.map((item) => item.assetId),
    });
  }

  private async onRejected(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const writeOff = await this.lockFor(manager, event);
    if (writeOff.document_id !== event.documentId) {
      throw new Error(`El acta ${event.number} no es la de la baja ${writeOff.id}`);
    }
    if (writeOff.status === 'REJECTED') {
      return;
    }
    if (writeOff.status !== 'PENDING_SIGNATURES') {
      throw new Error(`La baja ${writeOff.id} está ${writeOff.status}, no pendiente de firmas`);
    }
    await manager.query(`UPDATE asset_write_off SET status = 'REJECTED', rejected_at = NOW() WHERE id = $1`, [writeOff.id]);
    await manager.query('UPDATE asset_write_off_item SET open = FALSE WHERE write_off_id = $1', [writeOff.id]);
    const rejecter = event.signers.find((signer) => signer.status === 'REJECTED');
    await this.writeOffs.audit(manager, AuditAction.WriteOffRejected, writeOff.id, writeOff.created_by, {
      documentId: event.documentId,
      documentNumber: event.number,
      rejectedByPersonId: rejecter?.personId ?? null,
    });
  }
}
