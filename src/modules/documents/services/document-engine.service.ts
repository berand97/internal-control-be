import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig, StorageDriver } from '../../../config/configuration.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import { readDocxPlaceholders, renderDocx } from '../../document-templates/domain/docx-template.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  type DocumentFormat,
  DOCUMENT_FORMATS,
  findFormat,
  formatNumber,
  initialSequenceValue,
  periodFor,
} from '../domain/document-formats.js';
import { PDF_CONVERTER, type PdfConverter } from '../pdf/pdf-converter.js';
import { SIGNATURE_PROVIDER, type SignatureProvider } from '../signature/signature-provider.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CONDITION_LABELS: Record<string, string> = {
  NEW: 'Nuevo',
  GOOD: 'Bueno',
  FAIR: 'Regular',
  POOR: 'Malo',
  OBSOLETE: 'Obsoleto',
};

export const UNVERIFIED_CONDITION = 'Sin verificar';

const conditionLabel = (condition: string | null, flags: ReadonlyArray<string>): string =>
  condition === null || flags.includes('PHYSICAL_CONDITION_UNKNOWN')
    ? UNVERIFIED_CONDITION
    : (CONDITION_LABELS[condition] ?? condition);

export interface DocumentRequestPayload {
  readonly formatKey: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly costCenterId?: string;
  readonly responsiblePersonId?: string;
  readonly assetIds?: ReadonlyArray<string>;
  readonly movementIds?: Record<string, string>;
  readonly signers?: Record<string, string>;
  readonly assetNotes?: Record<string, string>;
  readonly fields?: Record<string, string>;
}

export interface GeneratedDocument {
  readonly id: string;
  readonly formatKey: string;
  readonly number: string;
  readonly status: string;
  readonly pdfDriver: string;
  readonly pdfKey: string;
}

interface TemplateRow {
  id: string;
  sgc_version: string;
  effective_date: string;
  storage_driver: StorageDriver;
  storage_key: string;
}

interface SlotRow {
  sign_order: number;
  role: string;
  signer_person_id: string | null;
  signer_name: string | null;
  status: string;
  signed_at: Date | null;
}

interface PersonRow {
  id: string;
  first_name: string;
  last_name: string;
  document_number: string | null;
  position_title: string | null;
  email: string | null;
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

const longDate = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
    .format(date)
    .replaceAll(' de ', ' DE ')
    .toUpperCase();

const personName = (person: PersonRow | undefined): string =>
  person ? `${person.first_name} ${person.last_name}`.trim() : '';

@Injectable()
export class DocumentEngineService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(PDF_CONVERTER) private readonly pdf: PdfConverter,
    @Inject(SIGNATURE_PROVIDER) private readonly signatures: SignatureProvider,
  ) {}

  async formats() {
    const today = new Date().toISOString().slice(0, 10);
    const result = [];
    for (const format of DOCUMENT_FORMATS) {
      const template = await this.activeTemplate(format.key, today, this.dataSource.manager);
      const [sequence] = (await this.dataSource.query(
        'SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = $2',
        [format.key, periodFor(format, new Date())],
      )) as Array<{ current_value: string }>;
      result.push({
        ...format,
        activeTemplate: template
          ? { id: template.id, version: template.sgc_version, effectiveDate: template.effective_date }
          : null,
        lastIssuedNumber: sequence ? Number(sequence.current_value) : null,
      });
    }
    return result;
  }

  async uploadTemplate(
    formatKey: string,
    file: { readonly buffer: Buffer; readonly originalname: string },
    meta: { readonly sgcVersion: string; readonly effectiveDate: string },
    actorId: string | null,
  ) {
    const format = this.requireFormat(formatKey);
    const placeholders = readDocxPlaceholders(file.buffer);
    const stored = await this.storage.put({
      key: `document-templates/${format.key}/${meta.effectiveDate}-v${meta.sgcVersion}.docx`,
      body: file.buffer,
      contentType: DOCX_MIME,
    });
    const [row] = (await this.dataSource.query(
      `INSERT INTO document_template_version (format_key, sgc_code, sgc_version, effective_date, storage_driver,
         storage_key, file_hash, original_filename, placeholders, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        format.key,
        format.sgcCode,
        meta.sgcVersion,
        meta.effectiveDate,
        stored.driver,
        stored.key,
        stored.checksumSha256,
        file.originalname,
        JSON.stringify(placeholders),
        actorId,
      ],
    )) as Array<{ id: string }>;
    return { id: row?.id, formatKey: format.key, placeholders };
  }

  enqueue(manager: EntityManager, payload: DocumentRequestPayload, requestedBy: string | null): Promise<string> {
    this.requireFormat(payload.formatKey);
    return (
      manager.query(
        `INSERT INTO document_request (format_key, payload, requested_by) VALUES ($1, $2, $3) RETURNING id`,
        [payload.formatKey, JSON.stringify(payload), requestedBy],
      ) as Promise<Array<{ id: string }>>
    ).then((rows) => rows[0]?.id ?? '');
  }

  async processPending(limit = 20): Promise<{ generated: number; failed: number }> {
    const pending = (await this.dataSource.query(
      `SELECT id FROM document_request
       WHERE status = 'PENDING' OR (status = 'FAILED' AND attempts < 5)
       ORDER BY created_at LIMIT $1`,
      [limit],
    )) as Array<{ id: string }>;
    let generated = 0;
    let failed = 0;
    for (const { id } of pending) {
      try {
        const document = await this.dataSource.transaction(async (manager) => {
          const [request] = (await manager.query(
            `SELECT payload, requested_by FROM document_request
             WHERE id = $1 AND status <> 'GENERATED' FOR UPDATE SKIP LOCKED`,
            [id],
          )) as Array<{ payload: DocumentRequestPayload; requested_by: string | null }>;
          if (!request) {
            return null;
          }
          const created = await this.generateWithin(manager, request.payload, request.requested_by);
          await manager.query(
            `UPDATE document_request SET status = 'GENERATED', document_id = $2, processed_at = NOW(),
               attempts = attempts + 1, last_error = NULL WHERE id = $1`,
            [id, created.id],
          );
          return created;
        });
        if (document) {
          generated += 1;
          await this.requestSignatures(document.id).catch(() => undefined);
        }
      } catch (error) {
        failed += 1;
        await this.dataSource.query(
          `UPDATE document_request SET status = 'FAILED', attempts = attempts + 1, last_error = $2, processed_at = NOW()
           WHERE id = $1`,
          [id, error instanceof Error ? error.message.slice(0, 1000) : String(error)],
        );
      }
    }
    return { generated, failed };
  }

  async generate(payload: DocumentRequestPayload, actorId: string): Promise<GeneratedDocument> {
    const format = this.requireFormat(payload.formatKey);
    await this.assertPermission(actorId, format.generatePermission);
    const document = await this.dataSource.transaction((manager) => this.generateWithin(manager, payload, actorId));
    await this.requestSignatures(document.id).catch(() => undefined);
    return document;
  }

  async generateWithin(
    manager: EntityManager,
    payload: DocumentRequestPayload,
    actorId: string | null,
  ): Promise<GeneratedDocument> {
    const format = this.requireFormat(payload.formatKey);
    const now = new Date();
    const template = await this.activeTemplate(format.key, now.toISOString().slice(0, 10), manager);
    if (!template) {
      throw new ApiException(ErrorCode.TemplateNotActive, `No hay plantilla vigente para ${format.key}`);
    }
    const source = await this.storage.getFrom(template.storage_driver, template.storage_key);
    const context = await this.buildContext(manager, format, template, payload, now);

    const period = periodFor(format, now);
    const value = await this.reserve(manager, format, period);
    const number = formatNumber(format, period, value);
    const data = { ...context, documento: { ...context.documento, numero: number } };

    const docx = renderDocx(source, data);
    const pdf = await this.pdf.toPdf(docx, `${format.key}-${number}.docx`);
    const base = `documents/${format.key}/${period || 'unico'}/${number}`;
    const storedDocx = await this.storage.put({ key: `${base}.docx`, body: docx, contentType: DOCX_MIME });
    const storedPdf = await this.storage.put({ key: `${base}.pdf`, body: pdf, contentType: 'application/pdf' });

    const [row] = (await manager.query(
      `INSERT INTO document (format_key, number, period, sequence_value, template_version_id, status, entity_type,
         entity_id, data, docx_driver, docx_key, docx_hash, pdf_driver, pdf_key, pdf_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, 'PENDING_SIGNATURE', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        format.key,
        number,
        period,
        value,
        template.id,
        payload.entityType ?? null,
        payload.entityId ?? null,
        JSON.stringify(data),
        storedDocx.driver,
        storedDocx.key,
        storedDocx.checksumSha256,
        storedPdf.driver,
        storedPdf.key,
        storedPdf.checksumSha256,
        actorId,
      ],
    )) as Array<{ id: string }>;
    const documentId = row?.id ?? '';
    await this.linkAssets(manager, documentId, payload);
    const signers = context.firmantes as Array<{
      orden: number;
      rol: string;
      personId: string | null;
      nombre: string;
      documento: string;
    }>;
    for (const signer of signers) {
      await manager.query(
        `INSERT INTO document_signature (document_id, sign_order, role, signer_person_id, signer_name, signer_document)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [documentId, signer.orden, signer.rol, signer.personId, signer.nombre || null, signer.documento || null],
      );
    }
    return {
      id: documentId,
      formatKey: format.key,
      number,
      status: 'PENDING_SIGNATURE',
      pdfDriver: storedPdf.driver,
      pdfKey: storedPdf.key,
    };
  }

  async requestSignatures(documentId: string): Promise<void> {
    const document = await this.documentRow(documentId);
    if (document.signature_reference) {
      return;
    }
    const pdf = await this.storage.getFrom(document.pdf_driver, document.pdf_key);
    const signers = (await this.dataSource.query(
      `SELECT s.sign_order, s.role, s.signer_person_id, s.signer_name, s.signer_document, p.email
       FROM document_signature s LEFT JOIN person p ON p.id = s.signer_person_id
       WHERE s.document_id = $1 ORDER BY s.sign_order`,
      [documentId],
    )) as Array<{
      sign_order: number;
      role: string;
      signer_person_id: string | null;
      signer_name: string | null;
      signer_document: string | null;
      email: string | null;
    }>;
    const format = this.requireFormat(document.format_key);
    const { externalReference } = await this.signatures.request({
      documentId,
      documentNumber: document.number,
      formatKey: document.format_key,
      title: `${format.sgcCode} · ${format.name} · ${document.number}`,
      pdf,
      pdfSha256: sha256(pdf),
      signers: signers.map((signer) => ({
        order: signer.sign_order,
        role: signer.role,
        roleLabel: format.signers.find((spec) => spec.role === signer.role)?.label ?? signer.role,
        personId: signer.signer_person_id,
        name: signer.signer_name,
        documentNumber: signer.signer_document,
        email: signer.email,
      })),
    });
    await this.dataSource.query(
      'UPDATE document SET signature_provider = $2, signature_reference = $3 WHERE id = $1',
      [documentId, this.signatures.name, externalReference],
    );
  }

  async syncSignatures(documentId: string) {
    const document = await this.documentRow(documentId);
    if (!document.signature_reference) {
      await this.requestSignatures(documentId);
      return this.detail(documentId);
    }
    const statuses = await this.signatures.status(document.signature_reference);
    await this.dataSource.transaction(async (manager) => {
      for (const status of statuses) {
        await manager.query(
          `UPDATE document_signature SET status = $3, signed_at = $4, evidence = $5
           WHERE document_id = $1 AND sign_order = $2`,
          [documentId, status.order, status.status, status.signedAt ?? null, JSON.stringify(status.evidence ?? null)],
        );
      }
      await manager.query(
        `UPDATE document d SET
           status = CASE
             WHEN EXISTS (SELECT 1 FROM document_signature s WHERE s.document_id = d.id AND s.status = 'REJECTED') THEN 'REJECTED'
             WHEN NOT EXISTS (SELECT 1 FROM document_signature s WHERE s.document_id = d.id AND s.status <> 'SIGNED') THEN 'SIGNED'
             ELSE 'PENDING_SIGNATURE' END,
           signed_at = CASE
             WHEN NOT EXISTS (SELECT 1 FROM document_signature s WHERE s.document_id = d.id AND s.status <> 'SIGNED')
             THEN coalesce(d.signed_at, NOW()) END
         WHERE d.id = $1`,
        [documentId],
      );
    });
    await this.storeSignedPdf(documentId);
    return this.detail(documentId);
  }

  async sign(
    documentId: string,
    order: number,
    actor: AuthenticatedUser,
    rubricPng: Buffer,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    const { reference, sessionId, mfaEnabled } = await this.prepareSignerAction(documentId, order, actor);
    if (!this.signatures.capture) {
      throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no captura firmas en el sistema`);
    }
    await this.signatures.capture(reference, {
      order,
      signerUserId: actor.id,
      signerPersonId: actor.personId,
      sessionId,
      mfaEnabled,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      rubricPng,
    });
    await this.syncSignatures(documentId);
    return this.detail(documentId, actor);
  }

  async rejectSignature(
    documentId: string,
    order: number,
    actor: AuthenticatedUser,
    reason: string,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    const { reference, sessionId } = await this.prepareSignerAction(documentId, order, actor);
    if (!this.signatures.reject) {
      throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no recibe rechazos en el sistema`);
    }
    await this.signatures.reject(reference, {
      order,
      signerUserId: actor.id,
      signerPersonId: actor.personId,
      sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      reason,
    });
    await this.syncSignatures(documentId);
    return this.detail(documentId, actor);
  }

  async attestation(verificationCode: string) {
    const attestation = this.signatures.attestation ? await this.signatures.attestation(verificationCode) : null;
    if (!attestation) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe una firma con ese código');
    }
    return attestation;
  }

  async reassignSigner(
    documentId: string,
    order: number,
    personId: string,
    reason: string,
    actor: AuthenticatedUser,
    context: { readonly ipAddress: string | null; readonly userAgent: string | null },
  ) {
    const document = await this.documentRow(documentId);
    const format = this.requireFormat(document.format_key);
    await this.assertPermission(actor.id, format.generatePermission);
    const [person] = (await this.dataSource.query(
      'SELECT id, first_name, last_name, document_number, position_title, email FROM person WHERE id = $1',
      [personId],
    )) as PersonRow[];
    if (!person) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la persona indicada');
    }
    await this.dataSource.transaction(async (manager) => {
      const [locked] = (await manager.query('SELECT status, signature_reference FROM document WHERE id = $1 FOR UPDATE', [
        documentId,
      ])) as Array<{ status: string; signature_reference: string | null }>;
      if (locked?.status !== 'PENDING_SIGNATURE') {
        throw new ApiException(ErrorCode.InvalidState, 'El documento no está pendiente de firma');
      }
      const [slot] = (await manager.query(
        'SELECT role, signer_person_id, status FROM document_signature WHERE document_id = $1 AND sign_order = $2 FOR UPDATE',
        [documentId, order],
      )) as Array<{ role: string; signer_person_id: string | null; status: string }>;
      if (!slot) {
        throw new ApiException(ErrorCode.ResourceNotFound, `El documento no tiene el firmante ${order}`);
      }
      if (slot.status !== 'PENDING') {
        throw new ApiException(ErrorCode.InvalidState, `El firmante ${order} ya no está pendiente`);
      }
      if (slot.signer_person_id === personId) {
        throw new ApiException(ErrorCode.ValidationFailed, 'La persona ya está asignada a ese turno');
      }
      await manager.query(
        `UPDATE document_signature SET signer_person_id = $3, signer_name = $4, signer_document = $5
         WHERE document_id = $1 AND sign_order = $2`,
        [documentId, order, personId, personName(person) || null, person.document_number],
      );
      await manager.query(
        `INSERT INTO document_signature_reassignment (document_id, sign_order, role, from_person_id, to_person_id, reason,
           reassigned_by, session_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          documentId,
          order,
          slot.role,
          slot.signer_person_id,
          personId,
          reason,
          actor.id,
          actor.sessionId ?? null,
          context.ipAddress,
          context.userAgent,
        ],
      );
      if (locked.signature_reference) {
        if (!this.signatures.reassign) {
          throw new ApiException(ErrorCode.InvalidState, `El proveedor ${this.signatures.name} no permite reasignar firmantes`);
        }
        await this.signatures.reassign(
          locked.signature_reference,
          { order, personId, name: personName(person) || null, documentNumber: person.document_number },
          manager,
        );
      }
    });
    return this.detail(documentId, actor);
  }

  private async viewerState(
    document: { readonly status: string },
    format: DocumentFormat,
    slots: ReadonlyArray<SlotRow>,
    actor: AuthenticatedUser,
  ) {
    const mine = slots.filter((slot) => slot.signer_person_id !== null && slot.signer_person_id === actor.personId);
    const next = mine.find((slot) => slot.status === 'PENDING');
    const blocker = next ? await this.signerBlocker(document, slots, next.sign_order, actor) : null;
    return {
      personId: actor.personId,
      signerOrders: mine.map((slot) => slot.sign_order),
      isCurrentSigner:
        document.status === 'PENDING_SIGNATURE' &&
        next !== undefined &&
        slots.find((slot) => slot.status === 'PENDING')?.sign_order === next.sign_order,
      nextOrder: next?.sign_order ?? null,
      canSign: blocker !== null && blocker.code === null,
      blockedBy: blocker?.code ?? null,
      canReassign:
        document.status === 'PENDING_SIGNATURE' &&
        (await this.permissions.userHasPermission(actor.id, format.generatePermission)),
    };
  }

  private async signerSlots(documentId: string): Promise<SlotRow[]> {
    return (await this.dataSource.query(
      `SELECT s.sign_order, s.role, s.signer_person_id, s.signer_name, s.status, s.signed_at
       FROM document_signature s WHERE s.document_id = $1 ORDER BY s.sign_order`,
      [documentId],
    )) as SlotRow[];
  }

  private async signerBlocker(
    document: { readonly status: string },
    slots: ReadonlyArray<SlotRow>,
    order: number,
    actor: AuthenticatedUser,
  ): Promise<{ readonly code: ErrorCode | null; readonly mfaEnabled: boolean }> {
    if (document.status !== 'PENDING_SIGNATURE') {
      return { code: ErrorCode.InvalidState, mfaEnabled: false };
    }
    const slot = slots.find((item) => item.sign_order === order);
    if (!slot) {
      return { code: ErrorCode.ResourceNotFound, mfaEnabled: false };
    }
    if (slot.status !== 'PENDING') {
      return { code: ErrorCode.InvalidState, mfaEnabled: false };
    }
    if (!slot.signer_person_id) {
      return { code: ErrorCode.SignatureSignerUnassigned, mfaEnabled: false };
    }
    if (slot.signer_person_id !== actor.personId) {
      return { code: ErrorCode.SignatureNotDesignatedSigner, mfaEnabled: false };
    }
    if (slots.find((item) => item.status === 'PENDING')?.sign_order !== order) {
      return { code: ErrorCode.SignatureOutOfOrder, mfaEnabled: false };
    }
    const [session] = (await this.dataSource.query(
      `SELECT u.mfa_enabled FROM app_user u
       JOIN refresh_token_family f ON f.user_id = u.id
       WHERE u.id = $1 AND f.id = $2 AND f.status = 'ACTIVE' AND f.expires_at > NOW() AND u.status = 'ACTIVE'`,
      [actor.id, actor.sessionId ?? null],
    )) as Array<{ mfa_enabled: boolean }>;
    if (!actor.sessionId || !session) {
      return { code: ErrorCode.SignatureSessionInvalid, mfaEnabled: false };
    }
    if (!session.mfa_enabled) {
      return { code: ErrorCode.SignatureMfaRequired, mfaEnabled: false };
    }
    return { code: null, mfaEnabled: true };
  }

  private async prepareSignerAction(documentId: string, order: number, actor: AuthenticatedUser) {
    const document = await this.documentRow(documentId);
    const blocker = await this.signerBlocker(document, await this.signerSlots(documentId), order, actor);
    if (blocker.code === ErrorCode.InvalidState) {
      throw new ApiException(ErrorCode.InvalidState, `El documento no está pendiente de firma en el turno ${order}`);
    }
    if (blocker.code === ErrorCode.ResourceNotFound) {
      throw new ApiException(ErrorCode.ResourceNotFound, `El documento no tiene el firmante ${order}`);
    }
    if (blocker.code) {
      throw new ApiException(blocker.code);
    }
    if (!document.signature_reference) {
      await this.requestSignatures(documentId);
    }
    const reference = document.signature_reference ?? (await this.documentRow(documentId)).signature_reference;
    return { reference: reference ?? '', sessionId: actor.sessionId ?? '', mfaEnabled: blocker.mfaEnabled };
  }

  private async storeSignedPdf(documentId: string): Promise<void> {
    const document = await this.documentRow(documentId);
    if (document.status !== 'SIGNED' || document.signed_pdf_key || !document.signature_reference || !this.signatures.signedDocument) {
      return;
    }
    const signed = await this.signatures.signedDocument(document.signature_reference);
    const stored = await this.storage.put({
      key: `documents/${document.format_key}/${document.period || 'unico'}/${document.number}-firmado.pdf`,
      body: signed,
      contentType: 'application/pdf',
    });
    await this.dataSource.query(
      `UPDATE document SET signed_pdf_driver = $2, signed_pdf_key = $3, signed_pdf_hash = $4
       WHERE id = $1 AND signed_pdf_key IS NULL`,
      [documentId, stored.driver, stored.key, stored.checksumSha256],
    );
  }

  async detail(documentId: string, actor?: AuthenticatedUser) {
    const document = await this.documentRow(documentId);
    const format = this.requireFormat(document.format_key);
    if (actor) {
      await this.assertCanRead(documentId, format.readPermission, actor.id);
    }
    const slots = await this.signerSlots(documentId);
    const label = (role: string) => format.signers.find((spec) => spec.role === role)?.label ?? role;
    const signatures = slots.map((slot) => ({
      order: slot.sign_order,
      role: slot.role,
      roleLabel: label(slot.role),
      personId: slot.signer_person_id,
      name: slot.signer_name,
      status: slot.status,
      signedAt: slot.signed_at,
    }));
    const pending = document.status === 'PENDING_SIGNATURE' ? slots.find((slot) => slot.status === 'PENDING') : undefined;
    const currentTurn = pending
      ? {
          order: pending.sign_order,
          role: pending.role,
          roleLabel: label(pending.role),
          personId: pending.signer_person_id,
          name: pending.signer_name,
          assigned: pending.signer_person_id !== null,
        }
      : null;
    const reassignments = (await this.dataSource.query(
      `SELECT r.sign_order AS "order", r.role, r.from_person_id AS "fromPersonId", r.to_person_id AS "toPersonId",
              nullif(trim(concat_ws(' ', pf.first_name, pf.last_name)), '') AS "fromName",
              nullif(trim(concat_ws(' ', pt.first_name, pt.last_name)), '') AS "toName",
              r.reason, r.reassigned_by AS "reassignedBy", r.reassigned_at AS "reassignedAt"
       FROM document_signature_reassignment r
       LEFT JOIN person pf ON pf.id = r.from_person_id
       JOIN person pt ON pt.id = r.to_person_id
       WHERE r.document_id = $1 ORDER BY r.reassigned_at, r.id`,
      [documentId],
    )) as ReadonlyArray<Record<string, unknown>>;
    return {
      currentTurn,
      viewer: actor ? await this.viewerState(document, format, slots, actor) : null,
      reassignments,
      id: document.id,
      formatKey: document.format_key,
      number: document.number,
      status: document.status,
      entityType: document.entity_type,
      entityId: document.entity_id,
      pdfDriver: document.pdf_driver,
      signatureProvider: document.signature_provider,
      pdfSha256: document.pdf_hash,
      signedPdfSha256: document.signed_pdf_hash,
      signatures,
    };
  }

  async download(documentId: string, kind: 'pdf' | 'docx', actorId: string) {
    const document = await this.documentRow(documentId);
    await this.assertCanRead(documentId, this.requireFormat(document.format_key).readPermission, actorId);
    const signed = kind === 'pdf' && document.signed_pdf_driver && document.signed_pdf_key;
    const body = signed
      ? await this.storage.getFrom(document.signed_pdf_driver as StorageDriver, document.signed_pdf_key as string)
      : kind === 'pdf'
        ? await this.storage.getFrom(document.pdf_driver, document.pdf_key)
        : await this.storage.getFrom(document.docx_driver, document.docx_key);
    return {
      body,
      fileName: `${document.format_key}-${document.number}${signed ? '-firmado' : ''}.${kind}`,
      contentType: kind === 'pdf' ? 'application/pdf' : DOCX_MIME,
    };
  }

  private async reserve(manager: EntityManager, format: DocumentFormat, period: string): Promise<number> {
    const policy = this.config.getOrThrow('documents', { infer: true }).numberingPolicy;
    await manager.query(
      `INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)
       ON CONFLICT (format_key, period) DO NOTHING`,
      [format.key, period, initialSequenceValue(format, period, policy)],
    );
    const [row] = (await manager.query(
      `WITH reserved AS (
         UPDATE document_sequence SET current_value = current_value + 1, updated_at = NOW()
         WHERE format_key = $1 AND period = $2 RETURNING current_value
       ) SELECT current_value FROM reserved`,
      [format.key, period],
    )) as Array<{ current_value: string }>;
    if (!row) {
      throw new Error(`No se pudo reservar consecutivo para ${format.key}`);
    }
    return Number(row.current_value);
  }

  private async activeTemplate(formatKey: string, date: string, manager: EntityManager): Promise<TemplateRow | undefined> {
    const [row] = (await manager.query(
      `SELECT id, sgc_version, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, storage_driver, storage_key
       FROM document_template_version
       WHERE format_key = $1 AND effective_date <= $2
       ORDER BY effective_date DESC LIMIT 1`,
      [formatKey, date],
    )) as TemplateRow[];
    return row;
  }

  private async buildContext(
    manager: EntityManager,
    format: DocumentFormat,
    template: TemplateRow,
    payload: DocumentRequestPayload,
    now: Date,
  ) {
    const personIds = [
      payload.responsiblePersonId,
      ...Object.values(payload.signers ?? {}),
    ].filter((id): id is string => Boolean(id));
    const persons = personIds.length
      ? ((await manager.query(
          `SELECT id, first_name, last_name, document_number, position_title, email FROM person WHERE id = ANY($1)`,
          [personIds],
        )) as PersonRow[])
      : [];
    const byId = new Map(persons.map((person) => [person.id, person]));
    const missing = personIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, `Personas inexistentes: ${missing.join(', ')}`);
    }
    const [costCenter] = payload.costCenterId
      ? ((await manager.query('SELECT external_code, name FROM cost_center WHERE id = $1', [
          payload.costCenterId,
        ])) as Array<{ external_code: string; name: string }>)
      : [];
    if (payload.costCenterId && !costCenter) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'Centro de costo inexistente');
    }
    const assetIds = payload.assetIds ?? [];
    const assets = assetIds.length
      ? ((await manager.query(
          `SELECT a.id, a.internal_code, a.description, a.physical_condition, a.data_quality_flags, o.legacy_asset_id,
             (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1) AS visible_code,
             (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1) AS legacy_code
           FROM asset a LEFT JOIN asset_import_origin o ON o.asset_id = a.id
           WHERE a.id = ANY($1)`,
          [assetIds],
        )) as Array<{
          id: string;
          internal_code: string;
          description: string;
          physical_condition: string | null;
          data_quality_flags: string[];
          legacy_asset_id: string | null;
          visible_code: string | null;
          legacy_code: string | null;
        }>)
      : [];
    if (assets.length !== new Set(assetIds).size) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'Hay activos inexistentes en la solicitud');
    }
    const ordered = assetIds
      .map((id) => assets.find((asset) => asset.id === id))
      .filter((asset): asset is (typeof assets)[number] => asset !== undefined);

    const responsible = payload.responsiblePersonId ? byId.get(payload.responsiblePersonId) : undefined;
    const signers = format.signers.map((spec) => {
      const personId =
        spec.source === 'RESPONSIBLE' ? (payload.responsiblePersonId ?? null) : (payload.signers?.[spec.role] ?? null);
      const person = personId ? byId.get(personId) : undefined;
      return {
        orden: spec.order,
        rol: spec.role,
        etiqueta: spec.label,
        personId,
        nombre: personName(person),
        documento: person?.document_number ?? '',
        cargo: person?.position_title ?? spec.label,
      };
    });
    const auditor = signers.find((signer) => signer.rol === 'AUDITA' || signer.rol === 'CONTROL_INTERNO');

    return {
      formato: {
        codigo: format.sgcCode,
        clave: format.key,
        nombre: format.name,
        version: template.sgc_version,
        fechaVigencia: template.effective_date,
      },
      documento: { numero: '', fecha: longDate(now), fechaIso: now.toISOString().slice(0, 10) },
      centroCosto: { codigo: costCenter?.external_code ?? '', nombre: costCenter?.name ?? '' },
      responsable: {
        nombre: personName(responsible),
        documento: responsible?.document_number ?? '',
        cargo: responsible?.position_title ?? '',
      },
      auditor: auditor
        ? { nombre: auditor.nombre, documento: auditor.documento, cargo: auditor.cargo }
        : { nombre: '', documento: '', cargo: '' },
      firmantes: signers,
      activos: ordered.map((asset, index) => ({
        indice: index + 1,
        id: asset.id,
        idOrigen: asset.legacy_asset_id ?? asset.internal_code,
        codigo: asset.visible_code ?? asset.legacy_code ?? asset.internal_code,
        descripcion: asset.description,
        unidades: 1,
        observacion: payload.assetNotes?.[asset.id] ?? '',
        estado: conditionLabel(asset.physical_condition, asset.data_quality_flags),
      })),
      totalElementos: ordered.length,
      campos: payload.fields ?? {},
    };
  }

  private async linkAssets(manager: EntityManager, documentId: string, payload: DocumentRequestPayload): Promise<void> {
    const assetIds = [...new Set(payload.assetIds ?? [])];
    const movementIds = payload.movementIds ?? {};
    const foreign = Object.keys(movementIds).filter((assetId) => !assetIds.includes(assetId));
    if (foreign.length > 0) {
      throw new ApiException(ErrorCode.ValidationFailed, `Movimientos de activos que no están en el documento: ${foreign.join(', ')}`);
    }
    if (assetIds.length === 0) {
      return;
    }
    const linked = (await manager.query(
      `INSERT INTO document_asset (document_id, asset_id, movement_id)
       SELECT $1, a.id, m.id
       FROM unnest($2::uuid[]) AS a(id)
       LEFT JOIN asset_movement m ON m.id = ($3::jsonb ->> a.id::text)::uuid AND m.asset_id = a.id
       RETURNING asset_id, movement_id`,
      [documentId, assetIds, JSON.stringify(movementIds)],
    )) as Array<{ asset_id: string; movement_id: string | null }>;
    const unmatched = linked.filter((item) => movementIds[item.asset_id] && !item.movement_id);
    if (unmatched.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        `El movimiento indicado no pertenece al activo: ${unmatched.map((item) => item.asset_id).join(', ')}`,
      );
    }
  }

  private async documentRow(documentId: string) {
    const [row] = (await this.dataSource.query('SELECT * FROM document WHERE id = $1', [documentId])) as Array<{
      id: string;
      format_key: string;
      number: string;
      period: string;
      status: string;
      entity_type: string | null;
      entity_id: string | null;
      pdf_driver: StorageDriver;
      pdf_key: string;
      pdf_hash: string;
      docx_driver: StorageDriver;
      docx_key: string;
      signature_provider: string | null;
      signature_reference: string | null;
      signed_pdf_driver: StorageDriver | null;
      signed_pdf_key: string | null;
      signed_pdf_hash: string | null;
    }>;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el documento');
    }
    return row;
  }

  private requireFormat(key: string): DocumentFormat {
    const format = findFormat(key);
    if (!format) {
      throw new ApiException(ErrorCode.ValidationFailed, `Formato desconocido: ${key}`);
    }
    return format;
  }

  private async assertCanRead(documentId: string, permission: string, actorId: string): Promise<void> {
    if (await this.permissions.userHasPermission(actorId, permission)) {
      return;
    }
    const [signer] = (await this.dataSource.query(
      `SELECT 1 AS found FROM document_signature s JOIN app_user u ON u.person_id = s.signer_person_id
       WHERE s.document_id = $1 AND u.id = $2 LIMIT 1`,
      [documentId, actorId],
    )) as Array<{ found: number }>;
    if (!signer) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${permission} o ser firmante del documento`);
    }
  }

  private async assertPermission(actorId: string, permission: string): Promise<void> {
    if (!(await this.permissions.userHasPermission(actorId, permission))) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${permission}`);
    }
  }
}
