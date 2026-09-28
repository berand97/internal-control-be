import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { Asset } from '../../assets/entities/asset.entity.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import {
  type DocumentLifecycleEvent,
  DocumentLifecycleRegistry,
} from '../../documents/lifecycle/document-lifecycle.registry.js';
import { TRANSFER_ENTITY_TYPE, TRANSFER_FORMAT_KEY, TRANSFER_SIGNER_SOURCES } from '../domain/transfer.js';
import { type TransferRow, TransfersService } from './transfers.service.js';

/**
 * El traslado se entera de su acta OCI-17-89 por el gancho del motor (entity_type TRANSFER). Todo corre en la
 * transacción del motor con el EntityManager que recibe; si lanza, el motor revierte y reintenta (lifecycle_error).
 * - onGenerated: enlaza el acta (asset_transfer.document_id).
 * - onSigned (acta totalmente firmada): cada activo pasa al centro de destino con AssetStateService.apply y un
 *   movimiento TRANSFER (documentReference = número del acta, metadata.transferId/documentId); el ítem y
 *   document_asset quedan enlazados a ese movimiento; el traslado queda COMPLETED. Las guardas se vuelven a
 *   comprobar: si algo cambió (préstamo, toma, baja), no se aplica nada y el error queda visible en el acta.
 *   Idempotente: un reintento sobre un traslado ya COMPLETED con esta acta no hace nada; un activo cuyo ítem ya tiene
 *   movimiento no se vuelve a mover.
 * - onRejected: REJECTED, activos liberados sin moverse.
 */
@Injectable()
export class TransferActLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly transfers: TransfersService,
    private readonly assetState: AssetStateService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: TRANSFER_ENTITY_TYPE,
      formats: [{ formatKey: TRANSFER_FORMAT_KEY, process: 'Traslados de activos', signers: TRANSFER_SIGNER_SOURCES }],
      onGenerated: (manager, event) => this.onGenerated(manager, event),
      onSigned: (manager, event) => this.onSigned(manager, event),
      onRejected: (manager, event) => this.onRejected(manager, event),
    });
  }

  private async lockFor(manager: EntityManager, event: DocumentLifecycleEvent): Promise<TransferRow> {
    if (event.formatKey !== TRANSFER_FORMAT_KEY) {
      throw new Error(`El acta ${event.number} es ${event.formatKey}, no ${TRANSFER_FORMAT_KEY}`);
    }
    if (!event.entityId) {
      throw new Error(`El acta ${event.number} no nombra su traslado`);
    }
    return this.transfers.lock(manager, event.entityId);
  }

  private async onGenerated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const transfer = await this.lockFor(manager, event);
    if (transfer.status !== 'PENDING_SIGNATURES' || transfer.document_id !== null) {
      throw new Error(`El traslado ${transfer.id} no espera acta (${transfer.document_id ?? transfer.status})`);
    }
    await manager.query('UPDATE asset_transfer SET document_id = $2 WHERE id = $1', [transfer.id, event.documentId]);
  }

  private async onSigned(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const transfer = await this.lockFor(manager, event);
    if (transfer.document_id !== event.documentId) {
      throw new Error(`El acta ${event.number} no es la del traslado ${transfer.id}`);
    }
    if (transfer.status === 'COMPLETED') {
      return;
    }
    if (transfer.status !== 'PENDING_SIGNATURES') {
      throw new Error(`El traslado ${transfer.id} está ${transfer.status}, no pendiente de firmas`);
    }
    // Quien autoriza el movimiento: quien firmó por Control Interno (si tiene usuario); si no, quien creó el traslado.
    const controlPerson = event.signersByRole['CONTROL_INTERNO'] ?? null;
    const [controlUser] = controlPerson
      ? ((await manager.query(
          `SELECT id FROM app_user WHERE person_id = $1 ORDER BY (status = 'ACTIVE') DESC, id LIMIT 1`,
          [controlPerson],
        )) as Array<{ id: string }>)
      : [];
    const authorizedBy = controlUser?.id ?? transfer.created_by;
    const items = (await manager.query(
      `SELECT asset_id AS "assetId", reason_id AS "reasonId", movement_id FROM asset_transfer_item
       WHERE transfer_id = $1 ORDER BY line_number`,
      [transfer.id],
    )) as Array<{ assetId: string; reasonId: string; movement_id: string | null }>;
    const pending = items.filter((item) => item.movement_id === null);
    // Mismas guardas que al crear (préstamo abierto, toma abierta, baja, mismo origen), con los activos bloqueados.
    await this.transfers.assertItems(manager, pending, transfer.source_cost_center_id, transfer.id, { checkReasons: false });
    for (const { assetId } of pending) {
      await this.assetState.apply(
        {
          assetId,
          actorId: authorizedBy,
          patch: { costCenterId: transfer.target_cost_center_id },
          movement: {
            type: MovementType.Transfer,
            reason: `Acta de traslado de activos ${TRANSFER_FORMAT_KEY} No. ${event.number}`,
            documentReference: event.number,
            requestedBy: transfer.created_by,
            metadata: { transferId: transfer.id, documentId: event.documentId },
          },
          guard: (current: Asset) => {
            if (current.operationalStatus === OperationalStatus.WrittenOff || current.operationalStatus === OperationalStatus.OnLoan) {
              throw new ApiException(ErrorCode.AssetCannotBeModified, `El activo ${current.internalCode} está ${current.operationalStatus}`);
            }
            if (current.costCenterId !== transfer.source_cost_center_id) {
              throw new ApiException(ErrorCode.TransferMixedSourceCostCenter, `El activo ${current.internalCode} ya no está en el centro de origen`);
            }
          },
          alsoWrite: async (tx) => {
            const [movement] = (await tx.query(
              `SELECT id FROM asset_movement
               WHERE asset_id = $1 AND movement_type = 'TRANSFER' AND metadata->>'transferId' = $2 AND metadata->>'documentId' = $3`,
              [assetId, transfer.id, event.documentId],
            )) as Array<{ id: string }>;
            if (!movement) {
              throw new Error(`No quedó el movimiento de traslado del activo ${assetId}`);
            }
            await tx.query('UPDATE asset_transfer_item SET movement_id = $3, open = FALSE WHERE transfer_id = $1 AND asset_id = $2', [
              transfer.id,
              assetId,
              movement.id,
            ]);
            const linked = (await tx.query(
              `WITH linked AS (
                 UPDATE document_asset SET movement_id = $3
                 WHERE document_id = $1 AND asset_id = $2 AND movement_id IS NULL RETURNING asset_id
               ) SELECT asset_id FROM linked`,
              [event.documentId, assetId, movement.id],
            )) as unknown[];
            if (linked.length !== 1) {
              throw new Error(`El acta ${event.number} no tiene al activo ${assetId} pendiente de enlazar a su movimiento`);
            }
          },
          audit: {
            action: AuditAction.AssetTransferred,
            changes: {
              from: transfer.source_cost_center_id,
              to: transfer.target_cost_center_id,
              transferId: transfer.id,
              documentId: event.documentId,
              documentNumber: event.number,
            },
          },
        },
        manager,
      );
    }
    await manager.query(
      `UPDATE asset_transfer SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
      [transfer.id],
    );
    await manager.query('UPDATE asset_transfer_item SET open = FALSE WHERE transfer_id = $1', [transfer.id]);
    await this.transfers.audit(manager, AuditAction.TransferCompleted, transfer.id, authorizedBy, {
      documentId: event.documentId,
      documentNumber: event.number,
      assets: items.map((item) => item.assetId),
    });
  }

  private async onRejected(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const transfer = await this.lockFor(manager, event);
    if (transfer.document_id !== event.documentId) {
      throw new Error(`El acta ${event.number} no es la del traslado ${transfer.id}`);
    }
    if (transfer.status === 'REJECTED') {
      return;
    }
    if (transfer.status !== 'PENDING_SIGNATURES') {
      throw new Error(`El traslado ${transfer.id} está ${transfer.status}, no pendiente de firmas`);
    }
    await manager.query(`UPDATE asset_transfer SET status = 'REJECTED', rejected_at = NOW() WHERE id = $1`, [transfer.id]);
    await manager.query('UPDATE asset_transfer_item SET open = FALSE WHERE transfer_id = $1', [transfer.id]);
    const rejecter = event.signers.find((signer) => signer.status === 'REJECTED');
    await this.transfers.audit(manager, AuditAction.TransferRejected, transfer.id, transfer.created_by, {
      documentId: event.documentId,
      documentNumber: event.number,
      rejectedByPersonId: rejecter?.personId ?? null,
    });
  }
}
