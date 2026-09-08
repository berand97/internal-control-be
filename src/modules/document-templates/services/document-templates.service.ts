import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { StorageService } from '../../../shared/storage/storage.service.js';
import { readDocxPlaceholders, renderDocx } from '../domain/docx-template.js';
import {
  DOCUMENT_TYPES,
  PLACEHOLDER_CATALOG,
  type DocumentType,
} from '../domain/placeholder-catalog.js';
import {
  DocumentTemplate,
  GeneratedDocument,
} from '../entities/document-template.entity.js';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 10 * 1024 * 1024;

export interface GeneratedDocumentResult {
  readonly id: string;
  readonly actNumber: string;
  readonly storageKey: string;
  readonly fileHash: string;
  readonly templateId: string;
}

@Injectable()
export class DocumentTemplatesService {
  constructor(
    @InjectRepository(DocumentTemplate)
    private readonly templates: Repository<DocumentTemplate>,
    @InjectRepository(GeneratedDocument)
    private readonly generated: Repository<GeneratedDocument>,
    private readonly storageService: StorageService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  catalog(): typeof PLACEHOLDER_CATALOG {
    return PLACEHOLDER_CATALOG;
  }

  async list(documentType?: DocumentType): Promise<ReadonlyArray<DocumentTemplate>> {
    return this.templates.find({
      where: documentType ? { documentType } : {},
      order: { documentType: 'ASC', version: 'DESC' },
    });
  }

  async upload(
    documentType: DocumentType,
    file: { readonly originalname: string; readonly buffer: Buffer; readonly mimetype: string; readonly size: number },
    actor: AuthenticatedUser,
  ): Promise<DocumentTemplate> {
    if (!DOCUMENT_TYPES.includes(documentType)) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    if (file.size > MAX_BYTES) {
      throw new ApiException(ErrorCode.FileTooLarge);
    }
    if (
      file.mimetype !== DOCX_MIME &&
      !file.originalname.toLowerCase().endsWith('.docx')
    ) {
      throw new ApiException(ErrorCode.FileTypeNotAllowed);
    }
    const placeholders = readDocxPlaceholders(file.buffer);
    const spec = PLACEHOLDER_CATALOG[documentType];
    const unknown = placeholders.filter(
      (item) =>
        !spec.required.includes(item) &&
        !spec.optional.includes(item),
    );
    if (unknown.length > 0) {
      throw new ApiException(
        ErrorCode.TemplateUnknownPlaceholder,
        undefined,
        unknown.map((field) => ({ field, message: field })),
      );
    }
    const missing = spec.required.filter((item) => !placeholders.includes(item));
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.TemplateMissingPlaceholder,
        undefined,
        missing.map((field) => ({ field, message: field })),
      );
    }
    const latest = await this.templates.findOne({
      where: { documentType },
      order: { version: 'DESC' },
    });
    const version = (latest?.version ?? 0) + 1;
    const stored = await this.storageService.put({
      key: `templates/${documentType}/v${version}.docx`,
      body: file.buffer,
      contentType: DOCX_MIME,
    });
    await this.templates.update({ documentType, isActive: true }, { isActive: false });
    const row = this.templates.create({
      documentType,
      version,
      storageKey: stored.key,
      fileHash: stored.checksumSha256,
      originalFilename: file.originalname,
      placeholders: [...placeholders],
      isActive: true,
      createdAt: new Date(),
      createdBy: actor.id,
    });
    const saved = await this.templates.save(row);
    await this.auditLogsRepository.record({
      action: AuditAction.TemplateUploaded,
      entityType: 'DOCUMENT_TEMPLATE',
      entityId: saved.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { documentType, version },
    });
    return saved;
  }

  async activate(id: string, actor: AuthenticatedUser): Promise<DocumentTemplate> {
    const template = await this.templates.findOne({ where: { id } });
    if (!template) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    await this.templates.update(
      { documentType: template.documentType, isActive: true },
      { isActive: false },
    );
    template.isActive = true;
    await this.templates.save(template);
    await this.auditLogsRepository.record({
      action: AuditAction.TemplateActivated,
      entityType: 'DOCUMENT_TEMPLATE',
      entityId: template.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { documentType: template.documentType, version: template.version },
    });
    return template;
  }

  async generate(input: {
    readonly documentType: DocumentType;
    readonly entityType: string;
    readonly entityId: string;
    readonly context: Record<string, unknown>;
    readonly actorId: string;
  }): Promise<GeneratedDocumentResult | null> {
    const template = await this.templates.findOne({
      where: { documentType: input.documentType, isActive: true },
    });
    if (!template) {
      return null;
    }
    const source = await this.storageService.get(template.storageKey);
    const actNumber = await this.nextActNumber();
    const rendered = renderDocx(source, {
      ...input.context,
      'acta.numero': actNumber,
      'acta.fecha': new Date().toISOString().slice(0, 10),
    });
    const stored = await this.storageService.put({
      key: `generated/${new Date().getFullYear()}/${input.documentType}/${actNumber}.docx`,
      body: rendered,
      contentType: DOCX_MIME,
    });
    const row = this.generated.create({
      documentType: input.documentType,
      templateId: template.id,
      storageKey: stored.key,
      fileHash: stored.checksumSha256,
      actNumber,
      entityType: input.entityType,
      entityId: input.entityId,
      createdAt: new Date(),
      createdBy: input.actorId,
    });
    const saved = await this.generated.save(row);
    return {
      id: saved.id,
      actNumber: saved.actNumber,
      storageKey: saved.storageKey,
      fileHash: saved.fileHash,
      templateId: saved.templateId,
    };
  }

  private async nextActNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const rows: unknown = await this.templates.query(
      `
      UPDATE code_sequence
      SET current_value = current_value + 1, updated_at = NOW()
      WHERE sequence_name = 'document_act'
      RETURNING current_value, padding_length, prefix
      `,
    );
    const row =
      Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
        ? (rows[0] as {
            current_value?: string | number;
            padding_length?: number;
            prefix?: string;
          })
        : null;
    const value = Number(row?.current_value ?? 1);
    const padding = Number(row?.padding_length ?? 4);
    const prefix = row?.prefix ?? 'ACT-';
    return `${prefix}${year}-${String(value).padStart(padding, '0')}`;
  }
}
