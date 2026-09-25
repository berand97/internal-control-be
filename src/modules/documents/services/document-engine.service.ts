import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
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

export interface DocumentRequestPayload {
  readonly formatKey: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly costCenterId?: string;
  readonly responsiblePersonId?: string;
  readonly assetIds?: ReadonlyArray<string>;
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
    const { externalReference } = await this.signatures.request({
      documentId,
      documentNumber: document.number,
      formatKey: document.format_key,
      pdf,
      pdfSha256: sha256(pdf),
      signers: signers.map((signer) => ({
        order: signer.sign_order,
        role: signer.role,
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
    return this.detail(documentId);
  }

  async detail(documentId: string, actorId?: string) {
    const document = await this.documentRow(documentId);
    if (actorId) {
      await this.assertPermission(actorId, this.requireFormat(document.format_key).readPermission);
    }
    const signatures = (await this.dataSource.query(
      `SELECT sign_order AS "order", role, signer_name AS name, status, signed_at AS "signedAt"
       FROM document_signature WHERE document_id = $1 ORDER BY sign_order`,
      [documentId],
    )) as ReadonlyArray<Record<string, unknown>>;
    return {
      id: document.id,
      formatKey: document.format_key,
      number: document.number,
      status: document.status,
      entityType: document.entity_type,
      entityId: document.entity_id,
      pdfDriver: document.pdf_driver,
      signatureProvider: document.signature_provider,
      signatures,
    };
  }

  async download(documentId: string, kind: 'pdf' | 'docx', actorId: string) {
    const document = await this.documentRow(documentId);
    await this.assertPermission(actorId, this.requireFormat(document.format_key).readPermission);
    const body =
      kind === 'pdf'
        ? await this.storage.getFrom(document.pdf_driver, document.pdf_key)
        : await this.storage.getFrom(document.docx_driver, document.docx_key);
    return {
      body,
      fileName: `${document.format_key}-${document.number}.${kind}`,
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
          `SELECT a.id, a.internal_code, a.description, a.physical_condition, o.legacy_asset_id,
             (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1) AS visible_code,
             (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1) AS legacy_code
           FROM asset a LEFT JOIN asset_import_origin o ON o.asset_id = a.id
           WHERE a.id = ANY($1)`,
          [assetIds],
        )) as Array<{
          id: string;
          internal_code: string;
          description: string;
          physical_condition: string;
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
        estado: CONDITION_LABELS[asset.physical_condition] ?? asset.physical_condition,
      })),
      totalElementos: ordered.length,
      campos: payload.fields ?? {},
    };
  }

  private async documentRow(documentId: string) {
    const [row] = (await this.dataSource.query('SELECT * FROM document WHERE id = $1', [documentId])) as Array<{
      id: string;
      format_key: string;
      number: string;
      status: string;
      entity_type: string | null;
      entity_id: string | null;
      pdf_driver: StorageDriver;
      pdf_key: string;
      docx_driver: StorageDriver;
      docx_key: string;
      signature_provider: string | null;
      signature_reference: string | null;
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

  private async assertPermission(actorId: string, permission: string): Promise<void> {
    if (!(await this.permissions.userHasPermission(actorId, permission))) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${permission}`);
    }
  }
}
