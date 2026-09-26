import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  type DocumentLifecycleEvent,
  DocumentLifecycleRegistry,
} from '../../documents/lifecycle/document-lifecycle.registry.js';
import { LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY, LOAN_RETURN_FORMAT } from '../domain/loan-documents.js';
import { canTransition } from '../domain/loan-transitions.js';
import { AssetLoan } from '../entities/asset-loan.entity.js';
import { AssetLoanEvent } from '../entities/asset-loan-item.entity.js';

/** Actas que se pueden reemplazar por una nueva (regenerateDeliveryAct): la rechazada queda como registro. */
const REPLACEABLE_ACT_STATUSES = ['REJECTED', 'VOIDED'];

/**
 * El préstamo se entera de sus actas por el gancho del motor de documentos (un manejador para entity_type LOAN,
 * que distingue el formato):
 *
 * Acta de entrega (OCI-01-65):
 * - onGenerated: enlaza el acta (asset_loan.delivery_document_id) y registra DELIVERY_ACT_GENERATED. Si el préstamo
 *   ya tenía otra, solo la reemplaza cuando la anterior está REJECTED o VOIDED (acta nueva tras un rechazo).
 * - onSigned: registra DELIVERY_ACT_SIGNED y, si el préstamo está PENDING_SIGNATURES, lo pasa a ACTIVE en esta misma
 *   transacción (payload.activated). Un préstamo entregado antes de esta regla (ya ACTIVE/OVERDUE) solo registra.
 * - onRejected: registra DELIVERY_ACT_REJECTED; el préstamo sigue PENDING_SIGNATURES (nueva acta o deshacer).
 * Acta de devolución (LOAN_RETURN): registra RETURN_ACT_GENERATED / RETURN_ACT_SIGNED / RETURN_ACT_REJECTED.
 *
 * Todo corre dentro de la transacción del motor, con el EntityManager que recibe; si lanza, el motor revierte.
 */
@Injectable()
export class LoanDeliveryActLifecycle implements OnModuleInit {
  constructor(private readonly lifecycle: DocumentLifecycleRegistry) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: LOAN_DOCUMENT_ENTITY,
      onGenerated: (manager, event) =>
        event.formatKey === LOAN_RETURN_FORMAT ? this.returnAct(manager, event, 'RETURN_ACT_GENERATED') : this.generated(manager, event),
      onSigned: (manager, event) =>
        event.formatKey === LOAN_RETURN_FORMAT ? this.returnAct(manager, event, 'RETURN_ACT_SIGNED') : this.signed(manager, event),
      onRejected: (manager, event) =>
        event.formatKey === LOAN_RETURN_FORMAT
          ? this.returnAct(manager, event, 'RETURN_ACT_REJECTED')
          : this.completed(manager, event, 'DELIVERY_ACT_REJECTED', {}),
    });
  }

  private async generated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const loan = await this.lockLoan(manager, event);
    if (loan.deliveryDocumentId && loan.deliveryDocumentId !== event.documentId) {
      const [previous] = (await manager.query('SELECT status FROM document WHERE id = $1', [loan.deliveryDocumentId])) as Array<{
        status: string;
      }>;
      if (!previous || !REPLACEABLE_ACT_STATUSES.includes(previous.status)) {
        throw new Error(`El préstamo ${loan.id} ya tiene acta de entrega vigente (${loan.deliveryDocumentId})`);
      }
    }
    if (!loan.deliveredAt) {
      throw new Error(`El préstamo ${loan.id} no se ha entregado: su acta de entrega no corresponde`);
    }
    await manager.update(AssetLoan, loan.id, { deliveryDocumentId: event.documentId });
    await manager.save(
      manager.create(AssetLoanEvent, {
        loanId: loan.id,
        eventType: 'DELIVERY_ACT_GENERATED',
        payload: {
          documentId: event.documentId,
          number: event.number,
          signersByRole: event.signersByRole,
          ...(loan.deliveryDocumentId && loan.deliveryDocumentId !== event.documentId
            ? { replacesDocumentId: loan.deliveryDocumentId }
            : {}),
        },
        // Quien entregó encoló el acta: es el autor de la generación.
        performedBy: loan.deliveredBy ?? loan.requestedBy,
        createdAt: new Date(),
      }),
    );
  }

  private async signed(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const loan = await this.lockLoan(manager, event);
    const activated = loan.status === 'PENDING_SIGNATURES';
    if (activated) {
      if (!canTransition(loan.status, 'ACTIVE')) {
        throw new Error(`El préstamo ${loan.id} no puede pasar de ${loan.status} a ACTIVE`);
      }
      await manager.update(AssetLoan, loan.id, { status: 'ACTIVE', updatedAt: new Date() });
    }
    await this.completed(manager, event, 'DELIVERY_ACT_SIGNED', { activated, loan });
  }

  private async completed(
    manager: EntityManager,
    event: DocumentLifecycleEvent,
    eventType: 'DELIVERY_ACT_SIGNED' | 'DELIVERY_ACT_REJECTED',
    options: { readonly activated?: boolean; readonly loan?: AssetLoan },
  ): Promise<void> {
    const loan = options.loan ?? (await this.lockLoan(manager, event));
    if (loan.deliveryDocumentId !== event.documentId) {
      throw new Error(`El acta ${event.documentId} no es el acta de entrega del préstamo ${loan.id}`);
    }
    await this.record(manager, loan, event, eventType, {
      closedBy: eventType === 'DELIVERY_ACT_REJECTED' ? 'REJECTED' : 'SIGNED',
      ...(eventType === 'DELIVERY_ACT_SIGNED' ? { activated: options.activated ?? false } : {}),
    });
  }

  private async returnAct(
    manager: EntityManager,
    event: DocumentLifecycleEvent,
    eventType: 'RETURN_ACT_GENERATED' | 'RETURN_ACT_SIGNED' | 'RETURN_ACT_REJECTED',
  ): Promise<void> {
    const loan = await this.lockLoan(manager, event);
    await this.record(manager, loan, event, eventType, {
      closedBy: eventType === 'RETURN_ACT_REJECTED' ? 'REJECTED' : eventType === 'RETURN_ACT_SIGNED' ? 'SIGNED' : null,
    });
  }

  private async record(
    manager: EntityManager,
    loan: AssetLoan,
    event: DocumentLifecycleEvent,
    eventType: string,
    extra: { readonly closedBy: 'SIGNED' | 'REJECTED' | null; readonly activated?: boolean },
  ): Promise<void> {
    // Quien cerró el acta: el último en firmar, o quien rechazó.
    const closer =
      extra.closedBy === 'REJECTED'
        ? event.signers.find((signer) => signer.status === 'REJECTED')
        : extra.closedBy === 'SIGNED'
          ? [...event.signers].sort((a, b) => b.order - a.order)[0]
          : undefined;
    const [user] = closer?.personId
      ? ((await manager.query(
          `SELECT id FROM app_user WHERE person_id = $1 ORDER BY (status = 'ACTIVE') DESC, id LIMIT 1`,
          [closer.personId],
        )) as Array<{ id: string }>)
      : [];
    await manager.save(
      manager.create(AssetLoanEvent, {
        loanId: loan.id,
        eventType,
        payload: {
          documentId: event.documentId,
          number: event.number,
          ...(extra.closedBy ? { closedByPersonId: closer?.personId ?? null } : {}),
          ...(extra.activated !== undefined ? { activated: extra.activated } : {}),
          signers: event.signers.map((signer) => ({
            order: signer.order,
            role: signer.role,
            personId: signer.personId,
            name: signer.name,
            status: signer.status,
            signedAt: signer.signedAt,
          })),
        },
        // performed_by es un usuario (NOT NULL): si el firmante no tiene usuario, queda quien entregó o recibió.
        performedBy: user?.id ?? loan.receivedBackBy ?? loan.deliveredBy ?? loan.requestedBy,
        createdAt: new Date(),
      }),
    );
  }

  private async lockLoan(manager: EntityManager, event: DocumentLifecycleEvent): Promise<AssetLoan> {
    if (event.formatKey !== LOAN_DELIVERY_FORMAT && event.formatKey !== LOAN_RETURN_FORMAT) {
      throw new Error(`El préstamo solo tiene actas ${LOAN_DELIVERY_FORMAT} y ${LOAN_RETURN_FORMAT}, no ${event.formatKey}`);
    }
    const loan = event.entityId
      ? await manager.findOne(AssetLoan, { where: { id: event.entityId }, lock: { mode: 'pessimistic_write' } })
      : null;
    if (!loan) {
      throw new Error(`No existe el préstamo ${event.entityId ?? '(sin id)'} del acta ${event.documentId}`);
    }
    return loan;
  }
}
