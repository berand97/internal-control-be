import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

/**
 * Gancho de completitud: el proceso de negocio que originó un acta (entrega, préstamo...) se entera de que el acta
 * se generó, quedó completamente firmada o fue rechazada, sin que el módulo de documentos lo conozca.
 *
 * Un módulo registra su manejador en onModuleInit:
 *
 *   constructor(private readonly lifecycle: DocumentLifecycleRegistry) {}
 *   onModuleInit() {
 *     this.lifecycle.register({ entityType: 'LOAN', onSigned: (manager, event) => this.applyLoan(manager, event) });
 *   }
 *
 * Garantías (DocumentEngineService):
 * - onGenerated corre dentro de la transacción que inserta el documento (processPending del outbox o generate).
 *   Si lanza, no hay documento: la solicitud del outbox queda FAILED con el error en last_error.
 * - onSigned corre dentro de la misma transacción que mueve el acta de PENDING_SIGNATURE a SIGNED, solo en esa
 *   transición (fila bloqueada con FOR UPDATE, nunca dos veces). Si lanza, la transición se revierte: el acta queda
 *   PENDING_SIGNATURE con todas sus firmas SIGNED, el error queda en document.lifecycle_error y el siguiente sync
 *   (POST /documents/:id/signatures/sync o el job de cada minuto, hasta 5 intentos automáticos) lo reintenta.
 * - onRejected igual, en la transición a REJECTED.
 * El manejador debe usar el EntityManager que recibe (no this.dataSource) para quedar dentro de la transacción, y
 * comprobar que event.documentId es el acta que su proceso espera: el entityType/entityId del acta viene del
 * payload de quien la generó.
 */
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
  /** Firmantes finales (después de cualquier reasignación), en orden de firma. */
  readonly signers: ReadonlyArray<DocumentLifecycleSigner>;
  /** personId del firmante final de cada rol: { RECIBE: '…', ENTREGA: '…', AUDITA: '…' }. */
  readonly signersByRole: Readonly<Record<string, string | null>>;
}

export type DocumentLifecycleCallback = (manager: EntityManager, event: DocumentLifecycleEvent) => Promise<void>;

export interface DocumentLifecycleHandler {
  readonly entityType: string;
  readonly onGenerated?: DocumentLifecycleCallback;
  readonly onSigned?: DocumentLifecycleCallback;
  readonly onRejected?: DocumentLifecycleCallback;
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
  /**
   * Estado de la generación más reciente de la entidad: la última solicitud del outbox (PENDING, FAILED o
   * GENERATED) o, si el acta se generó sin outbox, GENERATED. NONE si no hay ninguna.
   */
  readonly generation: EntityGenerationStatus;
  /** Solicitudes del outbox de la entidad, más recientes primero; FAILED trae lastError. */
  readonly requests: ReadonlyArray<EntityDocumentRequest>;
  /** Actas generadas para la entidad, más recientes primero. */
  readonly documents: ReadonlyArray<EntityDocument>;
}

@Injectable()
export class DocumentLifecycleRegistry {
  private readonly handlers = new Map<string, DocumentLifecycleHandler>();

  constructor(private readonly dataSource: DataSource) {}

  register(handler: DocumentLifecycleHandler): void {
    if (!handler.entityType.trim()) {
      throw new Error('El manejador del ciclo de vida del acta necesita un entityType');
    }
    if (this.handlers.has(handler.entityType)) {
      throw new Error(`Ya hay un manejador del ciclo de vida del acta para ${handler.entityType}`);
    }
    this.handlers.set(handler.entityType, handler);
  }

  has(entityType: string | null | undefined): boolean {
    return entityType !== null && entityType !== undefined && this.handlers.has(entityType);
  }

  /**
   * Corre el manejador de la fase para el documento, dentro de la transacción de `manager`.
   * Sin manejador registrado para su entity_type no hace nada. Los errores salen envueltos en DocumentLifecycleError.
   */
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
    } catch (error) {
      throw new DocumentLifecycleError(handler.entityType, phase, error);
    }
  }

  /** Estado de las actas de una entidad: solicitudes del outbox (pendientes, fallidas con su error) y documentos. */
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
