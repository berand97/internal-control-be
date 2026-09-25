import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  type DocumentLifecycleEvent,
  DocumentLifecycleRegistry,
} from '../../documents/lifecycle/document-lifecycle.registry.js';
import { LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY } from '../domain/loan-documents.js';
import { AssetLoan } from '../entities/asset-loan.entity.js';
import { AssetLoanEvent } from '../entities/asset-loan-item.entity.js';

/**
 * El préstamo se entera de su acta de entrega (OCI-01-65) por el gancho del motor de documentos:
 * - onGenerated: enlaza el acta (asset_loan.delivery_document_id) y registra DELIVERY_ACT_GENERATED.
 * - onSigned / onRejected: registra DELIVERY_ACT_SIGNED / DELIVERY_ACT_REJECTED. NO cambia el estado del préstamo:
 *   la entrega es la que lo activa. Si el préstamo debe esperar las firmas para quedar ACTIVE es una pregunta
 *   abierta para Control Interno.
 * Todo corre dentro de la transacción del motor, con el EntityManager que recibe; si lanza, el motor revierte.
 */
@Injectable()
export class LoanDeliveryActLifecycle implements OnModuleInit {
  constructor(private readonly lifecycle: DocumentLifecycleRegistry) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: LOAN_DOCUMENT_ENTITY,
      onGenerated: (manager, event) => this.generated(manager, event),
      onSigned: (manager, event) => this.completed(manager, event, 'DELIVERY_ACT_SIGNED'),
      onRejected: (manager, event) => this.completed(manager, event, 'DELIVERY_ACT_REJECTED'),
    });
  }

  private async generated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const loan = await this.lockLoan(manager, event);
    if (loan.deliveryDocumentId && loan.deliveryDocumentId !== event.documentId) {
      throw new Error(`El préstamo ${loan.id} ya tiene acta de entrega (${loan.deliveryDocumentId})`);
    }
    if (!loan.deliveredAt) {
      throw new Error(`El préstamo ${loan.id} no se ha entregado: su acta de entrega no corresponde`);
    }
    await manager.update(AssetLoan, loan.id, { deliveryDocumentId: event.documentId });
    await manager.save(
      manager.create(AssetLoanEvent, {
        loanId: loan.id,
        eventType: 'DELIVERY_ACT_GENERATED',
        payload: { documentId: event.documentId, number: event.number, signersByRole: event.signersByRole },
        // Quien entregó encoló el acta: es el autor de la generación.
        performedBy: loan.deliveredBy ?? loan.requestedBy,
        createdAt: new Date(),
      }),
    );
  }

  private async completed(
    manager: EntityManager,
    event: DocumentLifecycleEvent,
    eventType: 'DELIVERY_ACT_SIGNED' | 'DELIVERY_ACT_REJECTED',
  ): Promise<void> {
    const loan = await this.lockLoan(manager, event);
    if (loan.deliveryDocumentId !== event.documentId) {
      throw new Error(`El acta ${event.documentId} no es el acta de entrega del préstamo ${loan.id}`);
    }
    // Quien cerró el acta: el último en firmar, o quien rechazó.
    const closer =
      eventType === 'DELIVERY_ACT_REJECTED'
        ? event.signers.find((signer) => signer.status === 'REJECTED')
        : [...event.signers].sort((a, b) => b.order - a.order)[0];
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
          closedByPersonId: closer?.personId ?? null,
          signers: event.signers.map((signer) => ({
            order: signer.order,
            role: signer.role,
            personId: signer.personId,
            name: signer.name,
            status: signer.status,
            signedAt: signer.signedAt,
          })),
        },
        // performed_by es un usuario (NOT NULL): si el firmante no tiene usuario, queda quien entregó.
        performedBy: user?.id ?? loan.deliveredBy ?? loan.requestedBy,
        createdAt: new Date(),
      }),
    );
  }

  private async lockLoan(manager: EntityManager, event: DocumentLifecycleEvent): Promise<AssetLoan> {
    if (event.formatKey !== LOAN_DELIVERY_FORMAT) {
      throw new Error(`El préstamo solo tiene acta ${LOAN_DELIVERY_FORMAT}, no ${event.formatKey}`);
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
