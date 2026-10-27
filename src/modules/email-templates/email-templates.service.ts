import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import {
  CALLOUT_TONES,
  EMAIL_BLOCK_CATALOG,
  EMAIL_DESIGN_LIMITS,
  IMAGE_ALIGNS,
  SPACER_SIZES,
  imageAssetIds,
  normalizeEmailBlocks,
  validateEmailBlocks,
  type EmailBlock,
} from './domain/email-blocks.js';
import { DEFAULT_EMAIL_BRAND, type EmailBrand } from './domain/email-layout.js';
import { renderEmail, type EmailContext, type RenderedEmail } from './domain/email-renderer.js';
import {
  DEFAULT_EMAIL_DESIGNS,
  EMAIL_PLACEHOLDER_CATALOG,
  EMAIL_SAMPLE_CONTEXT,
  EMAIL_TEMPLATE_LABEL,
  EMAIL_TEMPLATE_TYPES,
  EMAIL_TEMPLATE_VARIABLES,
  checkDesignPlaceholders,
  type EmailTemplateDesign,
  type EmailTemplateType,
} from './domain/email-template-catalog.js';
import {
  EmailTemplateVersionResponseDto,
  type EmailPreviewResponseDto,
  type EmailTemplateCatalogResponseDto,
} from './dto/email-template.responses.js';
import { urlVariablesAsText } from './domain/url-variables-as-text.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { EmailAssetsService } from './email-assets.service.js';

export interface ValidDesign extends EmailTemplateDesign {
  readonly placeholders: ReadonlyArray<string>;
}

@Injectable()
export class EmailTemplatesService {
  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templates: Repository<EmailTemplate>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly assets: EmailAssetsService,
  ) {}

  async catalog(): Promise<EmailTemplateCatalogResponseDto> {
    const active = await this.templates.find({ where: { isActive: true } });
    const activeVersion = new Map(active.map((row) => [row.templateType, row.version]));
    return {
      types: EMAIL_TEMPLATE_TYPES.map((templateType) => ({
        templateType,
        label: EMAIL_TEMPLATE_LABEL[templateType],
        required: EMAIL_PLACEHOLDER_CATALOG[templateType].required,
        optional: EMAIL_PLACEHOLDER_CATALOG[templateType].optional,
        variables: EMAIL_TEMPLATE_VARIABLES[templateType],
        sampleContext: EMAIL_SAMPLE_CONTEXT[templateType],
        defaultSubject: DEFAULT_EMAIL_DESIGNS[templateType].subject,
        defaultBlocks: DEFAULT_EMAIL_DESIGNS[templateType].blocks,
        activeVersion: activeVersion.get(templateType) ?? null,
      })),
      blocks: EMAIL_BLOCK_CATALOG,
      limits: EMAIL_DESIGN_LIMITS,
      calloutTones: CALLOUT_TONES,
      spacerSizes: SPACER_SIZES,
      imageAligns: IMAGE_ALIGNS,
    };
  }

  async list(templateType: EmailTemplateType): Promise<ReadonlyArray<EmailTemplateVersionResponseDto>> {
    const rows = await this.templates.find({ where: { templateType }, order: { version: 'DESC' } });
    return rows.map((row) => EmailTemplateVersionResponseDto.from(row));
  }

  async create(
    templateType: EmailTemplateType,
    subject: string,
    blocks: unknown,
    actorId: string,
  ): Promise<EmailTemplateVersionResponseDto> {
    const design = await this.validate(templateType, subject, blocks);
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.lockType(manager, templateType);
      const repo = manager.getRepository(EmailTemplate);
      const latest = await repo.findOne({ where: { templateType }, order: { version: 'DESC' } });
      await repo.update({ templateType, isActive: true }, { isActive: false });
      const now = new Date();
      return repo.save(
        repo.create({
          templateType,
          version: (latest?.version ?? 0) + 1,
          subject: design.subject,
          blocks: design.blocks,
          placeholders: design.placeholders,
          isActive: true,
          createdAt: now,
          createdBy: actorId,
          activatedAt: now,
          activatedBy: actorId,
        }),
      );
    });
    return EmailTemplateVersionResponseDto.from(saved);
  }

  async activate(id: string, actorId: string): Promise<EmailTemplateVersionResponseDto> {
    const row = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EmailTemplate);
      const found = await repo.findOne({ where: { id } });
      if (!found) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      await this.lockType(manager, found.templateType);
      await repo.update({ templateType: found.templateType, isActive: true }, { isActive: false });
      found.isActive = true;
      found.activatedAt = new Date();
      found.activatedBy = actorId;
      return repo.save(found);
    });
    return EmailTemplateVersionResponseDto.from(row);
  }

  async preview(templateType: EmailTemplateType, subject: string, blocks: unknown): Promise<EmailPreviewResponseDto> {
    const design = await this.validate(templateType, subject, blocks);
    return this.renderDesign(design, EMAIL_SAMPLE_CONTEXT[templateType]);
  }

  async previewVersion(id: string): Promise<EmailPreviewResponseDto> {
    const row = await this.templates.findOne({ where: { id } });
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.renderDesign(row, EMAIL_SAMPLE_CONTEXT[row.templateType]);
  }

  async render(
    templateType: EmailTemplateType,
    context: EmailContext,
    templateId?: string | null,
  ): Promise<RenderedEmail> {
    const design = await this.resolveDesign(templateType, templateId ?? null);
    return this.renderDesign(design, context);
  }

  async resolveVersionId(templateType: EmailTemplateType, templateId: string | null): Promise<string | null> {
    if (templateId !== null) {
      const row = await this.templates.findOne({ where: { id: templateId, templateType } });
      if (!row) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      return row.id;
    }
    const active = await this.templates.findOne({ where: { templateType, isActive: true } });
    return active?.id ?? null;
  }

  async validate(templateType: EmailTemplateType, subject: string, blocks: unknown): Promise<ValidDesign> {
    const issues = validateEmailBlocks(blocks);
    if (issues.length > 0) {
      throw new ApiException(ErrorCode.EmailTemplateInvalidDesign, undefined, [...issues]);
    }
    const design: EmailTemplateDesign = {
      subject: subject.trim(),
      blocks: normalizeEmailBlocks(blocks as ReadonlyArray<EmailBlock>),
    };
    const linkIssues = urlVariablesAsText(templateType, design.blocks);
    if (linkIssues.length > 0) {
      throw new ApiException(ErrorCode.EmailTemplateInvalidDesign, undefined, [...linkIssues]);
    }
    const missingAssets = new Set(await this.assets.missing(imageAssetIds(design.blocks)));
    if (missingAssets.size > 0) {
      throw new ApiException(
        ErrorCode.EmailTemplateInvalidDesign,
        undefined,
        design.blocks.flatMap((block, index) =>
          block.type === 'image' && missingAssets.has(block.assetId)
            ? [{ field: `blocks[${index}].assetId`, message: 'La imagen ya no existe. Súbala de nuevo.' }]
            : [],
        ),
      );
    }
    const check = checkDesignPlaceholders(templateType, design);
    if (check.unknown.length > 0) {
      throw new ApiException(
        ErrorCode.EmailTemplateUnknownVariable,
        undefined,
        check.unknown.map((token) => ({ field: token, message: `La variable {{${token}}} no existe para este correo.` })),
      );
    }
    if (check.missing.length > 0) {
      throw new ApiException(
        ErrorCode.EmailTemplateMissingVariable,
        undefined,
        check.missing.map((token) => ({ field: token, message: `Falta la variable {{${token}}}.` })),
      );
    }
    return { ...design, placeholders: check.placeholders };
  }

  private async resolveDesign(
    templateType: EmailTemplateType,
    templateId: string | null,
  ): Promise<EmailTemplateDesign> {
    if (templateId !== null) {
      const chosen = await this.templates.findOne({ where: { id: templateId, templateType } });
      if (chosen) {
        return chosen;
      }
    }
    const active = await this.templates.findOne({ where: { templateType, isActive: true } });
    return active ?? DEFAULT_EMAIL_DESIGNS[templateType];
  }

  private async lockType(manager: EntityManager, templateType: EmailTemplateType): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email_template:${templateType}`]);
  }

  private async renderDesign(design: EmailTemplateDesign, context: EmailContext): Promise<RenderedEmail> {
    const assets = await this.assets.lookup(imageAssetIds(design.blocks));
    return renderEmail(design, context, this.brand(), assets);
  }

  private brand(): EmailBrand {
    const configured = this.config.get('emailBrand', { infer: true });
    return configured
      ? { name: configured.name || DEFAULT_EMAIL_BRAND.name, logoUrl: configured.logoUrl }
      : DEFAULT_EMAIL_BRAND;
  }
}
