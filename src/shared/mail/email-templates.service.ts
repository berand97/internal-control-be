import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_PLACEHOLDER_CATALOG,
  EMAIL_SAMPLE_CONTEXT,
  EMAIL_TEMPLATE_LABEL,
  EMAIL_TEMPLATE_TYPES,
  allowedEmailPlaceholders,
  extractEmailPlaceholders,
  renderEmailText,
  type EmailTemplateType,
} from './domain/email-template-catalog.js';
import type {
  EmailPreviewResponseDto,
  EmailTemplateCatalogItemDto,
  EmailTemplateResponseDto,
} from './dto/email-template.dto.js';
import { EmailTemplateResponseDto as TemplateDto } from './dto/email-template.dto.js';
import { EmailTemplate } from './entities/email-template.entity.js';

@Injectable()
export class EmailTemplatesService {
  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templates: Repository<EmailTemplate>,
  ) {}

  catalog(): ReadonlyArray<EmailTemplateCatalogItemDto> {
    return EMAIL_TEMPLATE_TYPES.map((templateType) => ({
      templateType,
      label: EMAIL_TEMPLATE_LABEL[templateType],
      required: EMAIL_PLACEHOLDER_CATALOG[templateType].required,
      optional: EMAIL_PLACEHOLDER_CATALOG[templateType].optional,
      defaultSubject: DEFAULT_EMAIL_TEMPLATES[templateType].subject,
      defaultBody: DEFAULT_EMAIL_TEMPLATES[templateType].body,
      sampleContext: EMAIL_SAMPLE_CONTEXT[templateType],
    }));
  }

  async list(templateType: EmailTemplateType): Promise<ReadonlyArray<EmailTemplateResponseDto>> {
    const rows = await this.templates.find({
      where: { templateType },
      order: { version: 'DESC' },
    });
    return rows.map(TemplateDto.from);
  }

  async save(
    templateType: EmailTemplateType,
    subject: string,
    body: string,
    actorId: string,
  ): Promise<EmailTemplateResponseDto> {
    const placeholders = this.assertPlaceholders(templateType, `${subject}\n${body}`);
    const latest = await this.templates.findOne({
      where: { templateType },
      order: { version: 'DESC' },
    });
    await this.templates.update({ templateType, isActive: true }, { isActive: false });
    const saved = await this.templates.save(
      this.templates.create({
        templateType,
        version: (latest?.version ?? 0) + 1,
        subject: subject.trim(),
        body,
        placeholders,
        isActive: true,
        createdAt: new Date(),
        createdBy: actorId,
      }),
    );
    return TemplateDto.from(saved);
  }

  async activate(id: string, actorId: string): Promise<EmailTemplateResponseDto> {
    const row = await this.templates.findOne({ where: { id } });
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    await this.templates.update(
      { templateType: row.templateType, isActive: true },
      { isActive: false },
    );
    row.isActive = true;
    row.createdBy = actorId;
    return TemplateDto.from(await this.templates.save(row));
  }

  async preview(
    templateType: EmailTemplateType,
    subject?: string,
    body?: string,
  ): Promise<EmailPreviewResponseDto> {
    const draft = await this.resolveDraft(templateType, subject, body);
    const sample = EMAIL_SAMPLE_CONTEXT[templateType];
    return {
      subject: renderEmailText(draft.subject, sample),
      body: renderEmailText(draft.body, sample),
    };
  }

  async render(
    templateType: EmailTemplateType,
    context: Record<string, string>,
  ): Promise<{ readonly subject: string; readonly text: string }> {
    const draft = await this.resolveDraft(templateType);
    return {
      subject: renderEmailText(draft.subject, context),
      text: renderEmailText(draft.body, context),
    };
  }

  private async resolveDraft(
    templateType: EmailTemplateType,
    subject?: string,
    body?: string,
  ): Promise<{ subject: string; body: string }> {
    if (subject !== undefined && body !== undefined) {
      this.assertPlaceholders(templateType, `${subject}\n${body}`);
      return { subject, body };
    }
    const active = await this.templates.findOne({
      where: { templateType, isActive: true },
    });
    if (active) {
      return { subject: active.subject, body: active.body };
    }
    return DEFAULT_EMAIL_TEMPLATES[templateType];
  }

  private assertPlaceholders(
    templateType: EmailTemplateType,
    text: string,
  ): ReadonlyArray<string> {
    const found = extractEmailPlaceholders(text);
    const allowed = allowedEmailPlaceholders(templateType);
    const unknown = found.filter((token) => !allowed.has(token));
    if (unknown.length > 0) {
      throw new ApiException(
        ErrorCode.TemplateUnknownPlaceholder,
        undefined,
        unknown.map((field) => ({ field, message: field })),
      );
    }
    const missing = EMAIL_PLACEHOLDER_CATALOG[templateType].required.filter(
      (token) => !found.includes(token),
    );
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.TemplateMissingPlaceholder,
        undefined,
        missing.map((field) => ({ field, message: field })),
      );
    }
    return found;
  }
}
