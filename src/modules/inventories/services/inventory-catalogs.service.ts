import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type {
  CreateFindingCategoryDto,
  CreateMissingCauseDto,
  UpdateFindingCategoryDto,
  UpdateMissingCauseDto,
} from '../dto/inventory-catalog.dto.js';
import { InventoryFindingCategory } from '../entities/inventory-finding-category.entity.js';
import { InventoryMissingCause } from '../entities/inventory-missing-cause.entity.js';
import type { CatalogViewContext } from './inventory-item-view.js';

const ENTITY_TYPE = 'INVENTORY_CATALOG';
const OTHER_USAGE_LIMIT = 200;

/**
 * Catálogos de la toma física: categorías de hallazgo (código corto) y causas de faltante. Una opción usada por
 * algún ítem no se borra: se desactiva. La auditoría guarda códigos y etiquetas del catálogo, nunca textos de ítems.
 */
@Injectable()
export class InventoryCatalogsService {
  constructor(
    @InjectRepository(InventoryFindingCategory)
    private readonly categories: Repository<InventoryFindingCategory>,
    @InjectRepository(InventoryMissingCause)
    private readonly causes: Repository<InventoryMissingCause>,
    private readonly dataSource: DataSource,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  /** Lo que necesita la serialización de ítems: categorías (para sugerir) y etiquetas de causas. */
  async viewContext(): Promise<CatalogViewContext> {
    const [categories, causes] = await Promise.all([this.categories.find(), this.causes.find()]);
    return {
      categories,
      causeLabels: new Map(causes.map((cause) => [cause.id, cause.label])),
    };
  }

  /** Categoría asignable a un ítem: existe y está activa. */
  async requireAssignableCategory(code: string): Promise<InventoryFindingCategory> {
    const category = await this.categories.findOne({ where: { code: code.trim().toUpperCase() } });
    if (!category || !category.isActive) {
      throw new ApiException(ErrorCode.InventoryCatalogEntryUnavailable);
    }
    return category;
  }

  async requireActiveCause(id: string): Promise<InventoryMissingCause> {
    const cause = await this.causes.findOne({ where: { id } });
    if (!cause || !cause.isActive) {
      throw new ApiException(ErrorCode.InventoryCatalogEntryUnavailable);
    }
    return cause;
  }

  /** Un faltante lleva exactamente una causa: del catálogo (activa) u "Otra" en texto (3..500). */
  async resolveMissingCause(
    causeId: string | undefined,
    otherCause: string | undefined,
  ): Promise<{ missingCauseId: string | null; missingCauseOther: string | null }> {
    const other = typeof otherCause === 'string' ? otherCause.trim() : '';
    const hasCause = typeof causeId === 'string' && causeId.length > 0;
    if (hasCause === (other.length > 0)) {
      throw new ApiException(ErrorCode.InventoryMissingCauseRequired);
    }
    if (hasCause) {
      const cause = await this.requireActiveCause(causeId);
      return { missingCauseId: cause.id, missingCauseOther: null };
    }
    if (other.length < 3 || other.length > 500) {
      throw new ApiException(ErrorCode.InventoryMissingCauseRequired);
    }
    return { missingCauseId: null, missingCauseOther: other };
  }

  // ---------- Categorías de hallazgo ----------

  async listFindingCategories() {
    const rows = await this.categories.find({ order: { sortOrder: 'ASC', code: 'ASC' } });
    const used = await this.usedCategoryCodes();
    return rows.map((row) => this.toCategory(row, used.has(row.code)));
  }

  async createFindingCategory(dto: CreateFindingCategoryDto, actor: AuthenticatedUser) {
    if (await this.categories.findOne({ where: { code: dto.code } })) {
      throw new ApiException(ErrorCode.InventoryCatalogEntryExists);
    }
    const saved = await this.categories.save(
      this.categories.create({
        code: dto.code,
        label: dto.label,
        description: dto.description ?? null,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
        suggestResults: dto.suggestResults ?? null,
        suggestConditions: dto.suggestConditions ?? null,
      }),
    );
    await this.audit(actor, saved.code, { catalog: 'FINDING_CATEGORY', op: 'CREATE', code: saved.code });
    return this.toCategory(await this.reloadCategory(saved.code), false);
  }

  async updateFindingCategory(code: string, dto: UpdateFindingCategoryDto, actor: AuthenticatedUser) {
    const category = await this.requireCategory(code);
    const patch: Partial<InventoryFindingCategory> = {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.description !== undefined ? { description: dto.description || null } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.suggestResults !== undefined ? { suggestResults: dto.suggestResults } : {}),
      ...(dto.suggestConditions !== undefined ? { suggestConditions: dto.suggestConditions } : {}),
    };
    await this.categories.update({ code: category.code }, { ...patch, updatedAt: new Date() });
    await this.audit(actor, category.code, {
      catalog: 'FINDING_CATEGORY',
      op: 'UPDATE',
      code: category.code,
      fields: Object.keys(patch),
    });
    const used = await this.usedCategoryCodes();
    return this.toCategory(await this.reloadCategory(category.code), used.has(category.code));
  }

  async deleteFindingCategory(code: string, actor: AuthenticatedUser) {
    const category = await this.requireCategory(code);
    if ((await this.usedCategoryCodes()).has(category.code)) {
      throw new ApiException(ErrorCode.InventoryCatalogEntryInUse);
    }
    await this.categories.delete({ code: category.code });
    await this.audit(actor, category.code, { catalog: 'FINDING_CATEGORY', op: 'DELETE', code: category.code });
    return { deleted: true };
  }

  // ---------- Causas de faltante ----------

  async listMissingCauses() {
    const rows = await this.causes.find({ order: { sortOrder: 'ASC', label: 'ASC' } });
    const used = await this.usedCauseIds();
    return rows.map((row) => this.toCause(row, used.has(row.id)));
  }

  async createMissingCause(dto: CreateMissingCauseDto, actor: AuthenticatedUser) {
    await this.assertCauseLabelFree(dto.label, null);
    const saved = await this.causes.save(
      this.causes.create({ label: dto.label, isActive: dto.isActive ?? true, sortOrder: dto.sortOrder ?? 0 }),
    );
    await this.audit(actor, saved.id, { catalog: 'MISSING_CAUSE', op: 'CREATE', label: saved.label });
    return this.toCause(await this.requireCause(saved.id), false);
  }

  async updateMissingCause(id: string, dto: UpdateMissingCauseDto, actor: AuthenticatedUser) {
    const cause = await this.requireCause(id);
    if (dto.label !== undefined) {
      await this.assertCauseLabelFree(dto.label, cause.id);
    }
    const patch: Partial<InventoryMissingCause> = {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    await this.causes.update({ id: cause.id }, { ...patch, updatedAt: new Date() });
    await this.audit(actor, cause.id, { catalog: 'MISSING_CAUSE', op: 'UPDATE', fields: Object.keys(patch) });
    const used = await this.usedCauseIds();
    return this.toCause(await this.requireCause(cause.id), used.has(cause.id));
  }

  async deleteMissingCause(id: string, actor: AuthenticatedUser) {
    const cause = await this.requireCause(id);
    if ((await this.usedCauseIds()).has(cause.id)) {
      throw new ApiException(ErrorCode.InventoryCatalogEntryInUse);
    }
    await this.causes.delete({ id: cause.id });
    await this.audit(actor, cause.id, { catalog: 'MISSING_CAUSE', op: 'DELETE', label: cause.label });
    return { deleted: true };
  }

  /**
   * Textos de la causa "Otra" agrupados sin distinguir mayúsculas ni espacios repetidos, del más usado al menos, para
   * que Control Interno convierta los frecuentes en causas del catálogo. Máximo 200 grupos.
   */
  async otherCauseUsage() {
    const rows = (await this.dataSource.query(
      `
      SELECT (array_agg(btrim(i.missing_cause_other) ORDER BY i.verified_at DESC NULLS LAST))[1] AS text,
             count(*)::int AS count,
             count(DISTINCT i.inventory_id)::int AS inventories,
             max(i.verified_at) AS last_used_at
      FROM physical_inventory_item i
      WHERE i.verification_result = 'MISSING' AND i.missing_cause_other IS NOT NULL
      GROUP BY lower(regexp_replace(btrim(i.missing_cause_other), '\\s+', ' ', 'g'))
      ORDER BY count(*) DESC, max(i.verified_at) DESC NULLS LAST
      LIMIT $1
      `,
      [OTHER_USAGE_LIMIT],
    )) as Array<{ text: string; count: number; inventories: number; last_used_at: Date | null }>;
    const [total] = (await this.dataSource.query(
      `SELECT count(*)::int AS total FROM physical_inventory_item
       WHERE verification_result = 'MISSING' AND missing_cause_other IS NOT NULL`,
    )) as Array<{ total: number }>;
    return {
      items: rows.map((row) => ({
        text: row.text,
        count: row.count,
        inventories: row.inventories,
        lastUsedAt: row.last_used_at,
      })),
      total: total?.total ?? 0,
    };
  }

  private async requireCategory(code: string): Promise<InventoryFindingCategory> {
    const category = await this.categories.findOne({ where: { code: code.trim().toUpperCase() } });
    if (!category) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return category;
  }

  private async reloadCategory(code: string): Promise<InventoryFindingCategory> {
    return this.requireCategory(code);
  }

  private async requireCause(id: string): Promise<InventoryMissingCause> {
    const cause = await this.causes.findOne({ where: { id } });
    if (!cause) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return cause;
  }

  private async assertCauseLabelFree(label: string, exceptId: string | null): Promise<void> {
    const rows = (await this.dataSource.query(
      `SELECT id FROM inventory_missing_cause WHERE lower(btrim(label)) = lower(btrim($1)) AND ($2::uuid IS NULL OR id <> $2)`,
      [label, exceptId],
    )) as Array<{ id: string }>;
    if (rows.length > 0) {
      throw new ApiException(ErrorCode.InventoryCatalogEntryExists);
    }
  }

  /** En uso: asignada a un ítem o citada en el historial de correcciones (borrarla dejaría el historial huérfano). */
  private async usedCategoryCodes(): Promise<ReadonlySet<string>> {
    const rows = (await this.dataSource.query(
      `SELECT finding_category_code AS code FROM physical_inventory_item WHERE finding_category_code IS NOT NULL
       UNION
       SELECT c.value->>'findingCategory' FROM inventory_item_correction ic,
         LATERAL (VALUES (ic.before), (ic.after)) AS c(value)
       WHERE c.value->>'findingCategory' IS NOT NULL`,
    )) as Array<{ code: string }>;
    return new Set(rows.map((row) => row.code));
  }

  /** En uso: causa de un faltante o citada en el historial de correcciones. */
  private async usedCauseIds(): Promise<ReadonlySet<string>> {
    const rows = (await this.dataSource.query(
      `SELECT missing_cause_id::text AS id FROM physical_inventory_item WHERE missing_cause_id IS NOT NULL
       UNION
       SELECT c.value->>'missingCauseId' FROM inventory_item_correction ic,
         LATERAL (VALUES (ic.before), (ic.after)) AS c(value)
       WHERE c.value->>'missingCauseId' IS NOT NULL`,
    )) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  private toCategory(row: InventoryFindingCategory, inUse: boolean) {
    return {
      code: row.code,
      label: row.label,
      description: row.description,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      suggestResults: row.suggestResults,
      suggestConditions: row.suggestConditions,
      inUse,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toCause(row: InventoryMissingCause, inUse: boolean) {
    return {
      id: row.id,
      label: row.label,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      inUse,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private audit(actor: AuthenticatedUser, entityKey: string, changes: Record<string, unknown>): Promise<void> {
    return this.auditLogs.record({
      action: AuditAction.InventoryCatalogChanged,
      entityType: ENTITY_TYPE,
      // audit_log.entity_id es UUID: las categorías (PK = código) se registran con el UUID nulo y su código en changes.
      entityId: /^[0-9a-f-]{36}$/i.test(entityKey) ? entityKey : '00000000-0000-0000-0000-000000000000',
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes,
    });
  }
}
