import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import { LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY } from '../../loans/domain/loan-documents.js';
import { LoansService } from '../../loans/services/loans.service.js';
import { TRANSFER_ENTITY_TYPE, TRANSFER_FORMAT_KEY } from '../../transfers/domain/transfer.js';
import { AssetRequestsService } from './asset-requests.service.js';

@Injectable()
export class AssetRequestCompletionObserver implements OnModuleInit {
  constructor(
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly requests: AssetRequestsService,
    private readonly loans: LoansService,
  ) {}

  onModuleInit(): void {
    this.loans.onDelivered((manager, event) => this.requests.onLoanDelivered(manager, event));
    this.loans.onRejected((manager, event) => this.requests.onLoanRejected(manager, event));
    this.loans.onCancelled((manager, event) => this.requests.onLoanCancelled(manager, event));
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
