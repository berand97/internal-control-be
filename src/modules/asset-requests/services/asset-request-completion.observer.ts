import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import { LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY } from '../../loans/domain/loan-documents.js';
import { TRANSFER_ENTITY_TYPE, TRANSFER_FORMAT_KEY } from '../../transfers/domain/transfer.js';
import { AssetRequestsService } from './asset-requests.service.js';

/**
 * «El documento completo llega a ambos centros»: cuando el acta de entrega del préstamo (OCI-01-65, préstamo → ACTIVE)
 * o el acta del traslado (OCI-17-89, traslado → COMPLETED) queda firmada, la solicitud que la originó avisa al
 * solicitante y a los jefes del centro dueño con el enlace al acta. Corre como observador del motor, después del
 * manejador del préstamo o del traslado y en su misma transacción.
 */
@Injectable()
export class AssetRequestCompletionObserver implements OnModuleInit {
  constructor(
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly requests: AssetRequestsService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.observe(LOAN_DOCUMENT_ENTITY, 'onSigned', async (manager, event) => {
      if (event.formatKey === LOAN_DELIVERY_FORMAT && event.entityId) {
        await this.requests.onDocumentSigned(manager, {
          column: 'loan_id',
          entityId: event.entityId,
          documentId: event.documentId,
          number: event.number,
        });
      }
    });
    this.lifecycle.observe(TRANSFER_ENTITY_TYPE, 'onSigned', async (manager, event) => {
      if (event.formatKey === TRANSFER_FORMAT_KEY && event.entityId) {
        await this.requests.onDocumentSigned(manager, {
          column: 'transfer_id',
          entityId: event.entityId,
          documentId: event.documentId,
          number: event.number,
        });
      }
    });
  }
}
