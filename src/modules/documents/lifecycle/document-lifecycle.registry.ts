import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { ProcessFormatBinding } from '../domain/document-formats.js';

export interface DocumentLifecycleSigner {
  readonly order: number;
  readonly role: string;
  readonly personId: string | null;
  readonly name: string | null;
  readonly documentNumber: string | null;
  readonly status: 'PENDING' | 'SIGNED' | 'REJECTED';
  readonly signedAt: Date | null;
}

export interface DocumentLifecycleEvent {
  readonly documentId: string;
  readonly formatKey: string;
  readonly number: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly signers: ReadonlyArray<DocumentLifecycleSigner>;
  readonly signersByRole: Readonly<Record<string, string | null>>;
}

export type DocumentLifecycleCallback = (manager: EntityManager, event: DocumentLifecycleEvent) => Promise<void>;

export interface DocumentLinks {
  readonly inventoryId: string | null;
  readonly costCenterId: string | null;
}

export const EMPTY_DOCUMENT_LINKS: DocumentLinks = { inventoryId: null, costCenterId: null };

export interface DocumentLifecycleHandler {
  readonly entityType: string;
  readonly onGenerated?: DocumentLifecycleCallback;
  readonly onSigned?: DocumentLifecycleCallback;
  readonly onRejected?: DocumentLifecycleCallback;
  readonly formats?: ReadonlyArray<ProcessFormatBinding>;
  readonly links?: (manager: EntityManager, entityId: string) => Promise<Partial<DocumentLinks>>;
}

export type DocumentLifecyclePhase = 'onGenerated' | 'onSigned' | 'onRejected';

export class DocumentLifecycleError extends Error {
  constructor(
    readonly entityType: string,
    readonly phase: DocumentLifecyclePhase,
    cause: unknown,
  ) {
    super(`${entityType}.${phase}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DocumentLifecycleError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntityGenerationStatus = 'NONE' | 'PENDING' | 'FAILED' | 'GENERATED';

export interface EntityDocumentRequest {
  readonly requestId: string;
  readonly formatKey: string;
  readonly status: 'PENDING' | 'FAILED' | 'GENERATED';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly documentId: string | null;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
}

export interface EntityDocument {
  readonly documentId: string;
  readonly formatKey: string;
  readonly number: string;
  readonly status: 'PENDING_SIGNATURE' | 'SIGNED' | 'REJECTED';
  readonly createdAt: Date;
  readonly signedAt: Date | null;
  readonly lifecycleError: string | null;
  readonly lifecycleFailedAt: Date | null;
  readonly lifecycleAttempts: number;
}

export interface EntityDocumentsState {
  readonly entityType: string;
  readonly entityId: string;
  readonly generation: EntityGenerationStatus;
  readonly requests: ReadonlyArray<EntityDocumentRequest>;
  readonly documents: ReadonlyArray<EntityDocument>;
}

@Injectable()
export class DocumentLifecycleRegistry {
  private readonly handlers = new Map<string, DocumentLifecycleHandler>();
  private readonly bindings = new Map<string, ProcessFormatBinding>();
  private readonly observers = new Map<string, DocumentLifecycleCallback[]>();

  constructor(private readonly dataSource: DataSource) {}

  register(handler: DocumentLifecycleHandler): void {
    if (!handler.entityType.trim()) {
      throw new Error('El manejador del ciclo de vida del acta necesita un entityType');
    }
    if (this.handlers.has(handler.entityType)) {
      throw new Error(`Ya hay un manejador del ciclo de vida del acta para ${handler.entityType}`);
    }
    for (const binding of handler.formats ?? []) {
      if (this.bindings.has(binding.formatKey)) {
        throw new Error(`El formato ${binding.formatKey} ya está enchufado a otro proceso`);
      }
    }
    this.handlers.set(handler.entityType, handler);
    for (const binding of handler.formats ?? []) {
      this.bindings.set(binding.formatKey, binding);
    }
  }

  observe(entityType: string, phase: DocumentLifecyclePhase, callback: DocumentLifecycleCallback): void {
    const key = `${entityType}:${phase}`;
    this.observers.set(key, [...(this.observers.get(key) ?? []), callback]);
  }

  bindingFor(formatKey: string): ProcessFormatBinding | undefined {
    return this.bindings.get(formatKey);
  }

  async links(entityType: string | null, entityId: string | null, manager?: EntityManager): Promise<DocumentLinks> {
    const handler = entityType ? this.handlers.get(entityType) : undefined;
    if (!handler?.links || !entityId || !UUID.test(entityId)) {
      return EMPTY_DOCUMENT_LINKS;
    }
    return { ...EMPTY_DOCUMENT_LINKS, ...(await handler.links(manager ?? this.dataSource.manager, entityId)) };
  }

  has(entityType: string | null | undefined): boolean {
    return entityType !== null && entityType !== undefined && this.handlers.has(entityType);
  }

  async dispatch(manager: EntityManager, phase: DocumentLifecyclePhase, documentId: string): Promise<void> {
    const [document] = (await manager.query(
      'SELECT id, format_key, number, entity_type, entity_id FROM document WHERE id = $1',
      [documentId],
    )) as Array<{ id: string; format_key: string; number: string; entity_type: string | null; entity_id: string | null }>;
    const handler = document?.entity_type ? this.handlers.get(document.entity_type) : undefined;
    const callback = handler?.[phase];
    if (!document || !handler || !callback) {
      return;
    }
    const signers = (await manager.query(
      `SELECT sign_order, role, signer_person_id, signer_name, signer_document, status, signed_at
       FROM document_signature WHERE document_id = $1 ORDER BY sign_order`,
      [documentId],
    )) as Array<{
      sign_order: number;
      role: string;
      signer_person_id: string | null;
      signer_name: string | null;
      signer_document: string | null;
      status: DocumentLifecycleSigner['status'];
      signed_at: Date | null;
    }>;
    const event: DocumentLifecycleEvent = {
      documentId: document.id,
      formatKey: document.format_key,
      number: document.number,
      entityType: handler.entityType,
      entityId: document.entity_id,
      signers: signers.map((signer) => ({
        order: signer.sign_order,
        role: signer.role,
        personId: signer.signer_person_id,
        name: signer.signer_name,
        documentNumber: signer.signer_document,
        status: signer.status,
        signedAt: signer.signed_at,
      })),
      signersByRole: Object.fromEntries(signers.map((signer) => [signer.role, signer.signer_person_id])),
    };
    try {
      await callback(manager, event);
      for (const observer of this.observers.get(`${handler.entityType}:${phase}`) ?? []) {
        await observer(manager, event);
      }
    } catch (error) {
      throw new DocumentLifecycleError(handler.entityType, phase, error);
    }
  }

  async stateFor(
    entityType: string,
    entityId: string,
    options: { readonly formatKey?: string; readonly manager?: EntityManager } = {},
  ): Promise<EntityDocumentsState> {
    const manager = options.manager ?? this.dataSource.manager;
    const formatKey = options.formatKey ?? null;
    const requests = (await manager.query(
      `SELECT id AS "requestId", format_key AS "formatKey", status, attempts, last_error AS "lastError",
              document_id AS "documentId", created_at AS "createdAt", processed_at AS "processedAt"
       FROM document_request
       WHERE payload->>'entityType' = $1 AND payload->>'entityId' = $2 AND ($3::text IS NULL OR format_key = $3)
       ORDER BY created_at DESC, id DESC`,
      [entityType, entityId, formatKey],
    )) as EntityDocumentRequest[];
    const documents = UUID.test(entityId)
      ? ((await manager.query(
          `SELECT id AS "documentId", format_key AS "formatKey", number, status, created_at AS "createdAt",
                  signed_at AS "signedAt", lifecycle_error AS "lifecycleError",
                  lifecycle_failed_at AS "lifecycleFailedAt", lifecycle_attempts AS "lifecycleAttempts"
           FROM document
           WHERE entity_type = $1 AND entity_id = $2::uuid AND ($3::text IS NULL OR format_key = $3)
           ORDER BY created_at DESC, id DESC`,
          [entityType, entityId, formatKey],
        )) as EntityDocument[])
      : [];
    const fromOutbox = new Set(requests.map((request) => request.documentId).filter(Boolean));
    const latestRequest = requests[0];
    const latestDirect = documents.find((document) => !fromOutbox.has(document.documentId));
    const generation: EntityGenerationStatus =
      latestDirect && (!latestRequest || latestDirect.createdAt > latestRequest.createdAt)
        ? 'GENERATED'
        : (latestRequest?.status ?? 'NONE');
    return { entityType, entityId, generation, requests, documents };
  }
}
