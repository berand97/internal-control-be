import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isOrgUnitCycle,
  isUniqueViolation,
} from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { checkUnitPrefix, pendingHeadCenterMessage, suggestUnitPrefix } from '../../cost-centers/domain/org-chart-rules.js';
import type { UnitPrefixSuggestionDto } from '../dto/responses/unit-prefix-suggestion.response.dto.js';
import type { StructureRemovalResultDto } from '../../cost-centers/dto/responses/structure-removal.response.dto.js';
import {
  type OrgHistoryEntry,
  OrgStructureHistoryService,
} from '../../cost-centers/services/org-structure-history.service.js';
import { decideUnitRemoval, StructureRemovalService } from '../../cost-centers/services/structure-removal.service.js';
import { StructureReconcilerService } from '../../cost-centers/services/structure-reconciler.service.js';
import { partialScope } from '../../cost-centers/domain/structure-reconcile.js';
import { OrgUnitType } from '../enums/org-unit-type.enum.js';
import { effectiveUnitColor } from '../domain/unit-color.js';
import { duplicateSiblingWarning, sameUnitName } from '../domain/unit-name.js';
import { CreateOrganizationalUnitDto } from '../dto/create-organizational-unit.dto.js';
import { QueryOrganizationalUnitsDto } from '../dto/query-organizational-units.dto.js';
import { OrganizationalUnitTreeResponseDto } from '../dto/responses/organizational-unit-tree.response.dto.js';
import {
  OrganizationalUnitResponseDto,
  OrganizationalUnitSaveResponseDto,
} from '../dto/responses/organizational-unit.response.dto.js';
import { UpdateOrganizationalUnitDto } from '../dto/update-organizational-unit.dto.js';
import type { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import type {
  OrganizationalUnitsRepository,
  UpdateOrgUnitRecord,
} from '../repositories/organizational-units.repository.interface.js';

const ORG_UNIT_ENTITY_TYPE = 'ORG_UNIT';

/** «43 · Contabilidad», o el nombre si no tiene prefijo (motivos del historial: solo códigos y nombres de la estructura). */
const unitLabel = (unit: { readonly codePrefix: string | null; readonly name: string }): string =>
  unit.codePrefix ? `${unit.codePrefix} · ${unit.name}` : unit.name;

const toPathSegment = (code: string): string => code.toLowerCase();

const childPath = (parentPath: string | null, code: string): string =>
  parentPath ? `${parentPath}/${toPathSegment(code)}` : `/${toPathSegment(code)}`;

interface HeadCenterChoice {
  readonly headCostCenterId: string | null;
  readonly headCostCenterCode: string | null;
  readonly warning: string | null;
}

/** inheritedColor: el color efectivo del padre (el de la rama que se está pintando). */
const buildTree = (
  units: ReadonlyArray<OrganizationalUnit>,
  parentId: string | null,
  inheritedColor: string | null = null,
): ReadonlyArray<OrganizationalUnitTreeResponseDto> =>
  units
    .filter((unit) => unit.parentId === parentId)
    .map((unit) => {
      const effectiveColor = unit.color ?? inheritedColor;
      return OrganizationalUnitTreeResponseDto.from(unit, buildTree(units, unit.id, effectiveColor), effectiveColor);
    });

@Injectable()
export class OrganizationalUnitsService {
  constructor(
    @Inject('OrganizationalUnitsRepository')
    private readonly unitsRepository: OrganizationalUnitsRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly dataSource: DataSource,
    private readonly removal: StructureRemovalService,
    private readonly history: OrgStructureHistoryService,
    private readonly reconciler: StructureReconcilerService,
  ) {}

  async list(
    query: QueryOrganizationalUnitsDto,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    const items = await this.unitsRepository.findAll(query.isActive);
    return items.map(OrganizationalUnitResponseDto.from);
  }

  /** Por defecto solo las activas (una archivada no aparece ni con sus hijas); includeArchived=true las muestra. */
  async tree(includeArchived = false): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    const items = await this.unitsRepository.findAll(includeArchived ? undefined : true);
    return buildTree(items, null);
  }

  /** Prefijo para una unidad nueva bajo parentId: el del ancestro más cercano con prefijo + un dígito libre. */
  async suggestPrefix(parentId: string | undefined): Promise<UnitPrefixSuggestionDto> {
    let ancestor = parentId ? await this.requireUnit(parentId) : null;
    for (let depth = 0; ancestor && !ancestor.codePrefix && depth < 64; depth += 1) {
      ancestor = ancestor.parentId ? await this.unitsRepository.findById(ancestor.parentId) : null;
    }
    const taken = new Set(
      (await this.unitsRepository.findAll(true)).flatMap((unit) => (unit.codePrefix ? [unit.codePrefix] : [])),
    );
    return suggestUnitPrefix(ancestor?.codePrefix ?? null, taken);
  }

  async getById(id: string): Promise<OrganizationalUnitResponseDto> {
    return OrganizationalUnitResponseDto.from(await this.requireUnit(id));
  }

  async descendants(
    id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    const unit = await this.requireUnit(id);
    const all = await this.unitsRepository.findAll();
    return buildTree(all, unit.id, effectiveUnitColor(unit, new Map(all.map((item) => [item.id, item]))));
  }

  async ancestors(
    id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    const unit = await this.requireUnit(id);
    const chain: OrganizationalUnit[] = [];
    let current: OrganizationalUnit | null = unit;
    while (current) {
      chain.push(current);
      current = current.parentId
        ? await this.unitsRepository.findById(current.parentId)
        : null;
    }
    return chain.reverse().map(OrganizationalUnitResponseDto.from);
  }

  async create(
    dto: CreateOrganizationalUnitDto,
    actor: AuthenticatedUser,
  ): Promise<OrganizationalUnitSaveResponseDto> {
    const parent = dto.parentId
      ? await this.requireUnit(dto.parentId)
      : null;
    this.assertCouncilWithoutPrefix(dto.type, dto.codePrefix ?? null);
    const prefixWarning = dto.codePrefix ? await this.assertPrefixInParent(dto.codePrefix, dto.name, parent, null) : null;
    if (dto.codePrefix && (dto.isActive ?? true)) {
      await this.assertPrefixFree(dto.codePrefix, null);
    }
    const nameWarning = (dto.isActive ?? true) ? await this.duplicateNameWarning(dto.name, parent, null) : null;
    const head = await this.chooseHeadCenter(dto);
    const warnings = [prefixWarning, nameWarning, head?.warning ?? null].filter((item): item is string => item !== null);
    try {
      const unit = await this.dataSource.transaction(async (manager) => {
        const created = await this.unitsRepository.insert(
          {
            parentId: parent?.id ?? null,
            code: dto.code,
            name: dto.name,
            unitType: dto.type,
            hierarchyLevel: parent ? parent.hierarchyLevel + 1 : 0,
            hierarchyPath: childPath(parent?.hierarchyPath ?? null, dto.code),
            isActive: dto.isActive ?? true,
            codePrefix: dto.codePrefix ?? null,
            ...(dto.relationType ? { relationType: dto.relationType } : {}),
            headCostCenterId: head?.headCostCenterId ?? null,
            headCostCenterCode: head?.headCostCenterCode ?? null,
            color: dto.color ?? null,
          },
          manager,
        );
        await this.auditLogsRepository.record(
          {
            action: AuditAction.OrgUnitCreated,
            entityType: ORG_UNIT_ENTITY_TYPE,
            entityId: created.id,
            performedBy: actor.id,
            ipAddress: null,
            userAgent: null,
            changes: { code: created.code },
          },
          manager,
        );
        await this.reconciler.reconcileWithin(
          manager,
          partialScope({ prefixes: [created.codePrefix], unitIds: [created.id] }),
          { actorId: actor.id, reason: `Se creó la unidad ${unitLabel(created)}`, ip: null, userAgent: null },
        );
        return created;
      });
      return { ...OrganizationalUnitResponseDto.from(unit), warnings };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.OrgUnitCodeAlreadyExists);
      }
      if (isOrgUnitCycle(error)) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateOrganizationalUnitDto,
    actor: AuthenticatedUser,
  ): Promise<OrganizationalUnitSaveResponseDto> {
    const unit = await this.requireUnit(id);
    let parentId = unit.parentId;
    let parent: OrganizationalUnit | null = unit.parentId
      ? await this.unitsRepository.findById(unit.parentId)
      : null;

    if (dto.parentId !== undefined) {
      if (dto.parentId === unit.id) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      if (dto.parentId) {
        parent = await this.requireUnit(dto.parentId);
        if (await this.isAncestorOf(unit.id, parent.id)) {
          throw new ApiException(ErrorCode.OrgUnitCycle);
        }
        parentId = parent.id;
      } else {
        parent = null;
        parentId = null;
      }
    }

    const nextPrefix = dto.codePrefix !== undefined ? dto.codePrefix : unit.codePrefix;
    this.assertCouncilWithoutPrefix(dto.type ?? unit.unitType, nextPrefix);
    const prefixWarning =
      nextPrefix && (nextPrefix !== unit.codePrefix || parentId !== unit.parentId)
        ? await this.assertPrefixInParent(nextPrefix, dto.name ?? unit.name, parent, unit.id)
        : null;
    if (nextPrefix && (dto.isActive ?? unit.isActive)) {
      await this.assertPrefixFree(nextPrefix, unit.id);
    }
    const previousParent = unit.parentId ? await this.unitsRepository.findById(unit.parentId) : null;
    // Solo si cambia el nombre o el jefe: una duplicada de antes no se vuelve a avisar en cada edición.
    const nextName = dto.name ?? unit.name;
    const nameWarning =
      (dto.isActive ?? unit.isActive) && (!sameUnitName(nextName, unit.name) || parentId !== unit.parentId)
        ? await this.duplicateNameWarning(nextName, parent, unit.id)
        : null;

    const head = await this.chooseHeadCenter(dto);
    const warnings = [prefixWarning, nameWarning, head?.warning ?? null].filter((item): item is string => item !== null);

    const nextCode = dto.code ?? unit.code;
    const nextPath = childPath(parent?.hierarchyPath ?? null, nextCode);
    const nextLevel = parent ? parent.hierarchyLevel + 1 : 0;
    const pathChanged = nextPath !== unit.hierarchyPath;

    const record: UpdateOrgUnitRecord = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.type !== undefined ? { unitType: dto.type } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.code !== undefined ? { code: dto.code } : {}),
      ...(dto.codePrefix !== undefined ? { codePrefix: dto.codePrefix } : {}),
      ...(dto.parentId !== undefined ? { parentId } : {}),
      ...(dto.relationType !== undefined ? { relationType: dto.relationType } : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
      ...(head ? { headCostCenterId: head.headCostCenterId, headCostCenterCode: head.headCostCenterCode } : {}),
      ...(pathChanged ? { hierarchyPath: nextPath, hierarchyLevel: nextLevel } : {}),
    };
    const after: OrganizationalUnit = { ...unit, ...record };
    const reconcileContext = { actorId: actor.id, reason: `Se editó la unidad ${unitLabel(after)}`, ip: null, userAgent: null };
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.unitsRepository.update(unit.id, record, manager);
        if (pathChanged && unit.hierarchyPath) {
          await this.unitsRepository.rewriteDescendantPaths(
            unit.hierarchyPath,
            nextPath,
            nextLevel - unit.hierarchyLevel,
            manager,
          );
        }
        await this.auditLogsRepository.record(
          {
            action: AuditAction.OrgUnitUpdated,
            entityType: ORG_UNIT_ENTITY_TYPE,
            entityId: unit.id,
            performedBy: actor.id,
            ipAddress: null,
            userAgent: null,
            changes: { ...dto },
          },
          manager,
        );
        await this.recordHistory(manager, unit, after, previousParent, parent, actor);
        // Prefijo, padre o estado: los centros del prefijo viejo y del nuevo y los que hoy están en la unidad.
        if (unit.codePrefix !== after.codePrefix || unit.parentId !== after.parentId || unit.isActive !== after.isActive) {
          await this.reconciler.reconcileWithin(
            manager,
            partialScope({ prefixes: [unit.codePrefix, after.codePrefix], unitIds: [unit.id] }),
            reconcileContext,
          );
        } else if (head) {
          await this.reconciler.reconcileWithin(manager, partialScope({ unitIds: [unit.id] }), reconcileContext);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.OrgUnitCodeAlreadyExists);
      }
      if (isOrgUnitCycle(error)) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      throw error;
    }
    const updated = await this.requireUnit(id);
    return { ...OrganizationalUnitResponseDto.from(updated), warnings };
  }

  /** Historial de nombre, código, tipo, padre, prefijo, línea, centro propio, estado y color (org_structure_history). */
  private async recordHistory(
    manager: EntityManager,
    before: OrganizationalUnit,
    after: OrganizationalUnit,
    previousParent: OrganizationalUnit | null,
    nextParent: OrganizationalUnit | null,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const label = (unit: OrganizationalUnit | null): string | null =>
      unit ? `${unit.codePrefix ? `${unit.codePrefix} · ` : ''}${unit.name}` : null;
    const centerCode = async (id: string | null): Promise<string | null> =>
      id ? ((await this.unitsRepository.costCenterCode(id)) ?? id) : null;
    const status = (active: boolean): string => (active ? 'ACTIVE' : 'ARCHIVED');
    const parentMoved = before.parentId !== after.parentId;
    const headChanged =
      before.headCostCenterId !== after.headCostCenterId || before.headCostCenterCode !== after.headCostCenterCode;
    const headLabel = async (unit: OrganizationalUnit): Promise<string | null> =>
      unit.headCostCenterId
        ? await centerCode(unit.headCostCenterId)
        : unit.headCostCenterCode
          ? `${unit.headCostCenterCode} (pendiente)`
          : null;
    const entries: OrgHistoryEntry[] = [
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'NAME', oldValue: before.name, newValue: after.name },
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'CODE', oldValue: before.code, newValue: after.code },
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'TYPE', oldValue: before.unitType, newValue: after.unitType },
      {
        entityType: 'ORG_UNIT',
        entityId: after.id,
        field: 'PARENT',
        oldValue: parentMoved ? label(previousParent) : null,
        newValue: parentMoved ? (label(nextParent) ?? '(raíz)') : null,
      },
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'PREFIX', oldValue: before.codePrefix, newValue: after.codePrefix },
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'RELATION', oldValue: before.relationType, newValue: after.relationType },
      {
        entityType: 'ORG_UNIT',
        entityId: after.id,
        field: 'HEAD_COST_CENTER',
        oldValue: headChanged ? await headLabel(before) : null,
        newValue: headChanged ? ((await headLabel(after)) ?? '(ninguno)') : null,
      },
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'STATUS', oldValue: status(before.isActive), newValue: status(after.isActive) },
      // null en newValue: color quitado (hereda el de su jefe).
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'COLOR', oldValue: before.color, newValue: after.color },
    ];
    await this.history.record(manager, entries, { actorId: actor.id, source: 'MANUAL' });
  }

  private assertCouncilWithoutPrefix(type: OrgUnitType, codePrefix: string | null): void {
    if (type === OrgUnitType.Council && codePrefix) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Un consejo o comité no lleva prefijo: no recibe centros de costo', [
        { field: 'codePrefix', message: 'Sin prefijo para un consejo o comité' },
      ]);
    }
  }

  /**
   * Prefijo frente al del jefe (checkUnitPrefix). No empezar por el del jefe es solo una advertencia (se devuelve):
   * «Control Interno (432) depende de Rectoría (1) pero conserva los códigos 432… de Contabilidad». 400
   * ORG_UNIT_PREFIX_OUT_OF_PARENT si es el mismo prefijo del jefe.
   */
  private async assertPrefixInParent(
    codePrefix: string,
    unitName: string,
    parent: OrganizationalUnit | null,
    unitId: string | null,
  ): Promise<string | null> {
    // Jefe con prefijo más cercano y prefijos de toda la cadena hacia arriba (nunca cuentan como «otra unidad»).
    let ancestor: OrganizationalUnit | null = null;
    const chain = new Set<string>();
    let current = parent;
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (current.codePrefix) {
        ancestor ??= current;
        chain.add(current.codePrefix);
      }
      current = current.parentId ? await this.unitsRepository.findById(current.parentId) : null;
    }
    const expected = ancestor?.codePrefix ?? null;
    const others = new Map(
      (await this.unitsRepository.findAll(true)).flatMap((unit) =>
        unit.codePrefix && unit.id !== unitId && unit.codePrefix !== codePrefix ? [[unit.codePrefix, unit.name] as const] : [],
      ),
    );
    const check = checkUnitPrefix(codePrefix, expected, others, chain, { child: unitName, ancestor: ancestor?.name ?? null });
    if (check.level === 'ERROR') {
      throw new ApiException(ErrorCode.OrgUnitPrefixOutOfParent, check.message ?? undefined, [
        { field: 'codePrefix', message: `${expected ?? ''}…` },
      ]);
    }
    return check.level === 'WARNING' ? check.message : null;
  }

  /**
   * Otra unidad activa con el mismo nombre (sin tildes ni mayúsculas) bajo el mismo jefe: advertencia, nunca error (los
   * nombres no son únicos: dos «Calidad» con prefijos distintos son válidas).
   */
  private async duplicateNameWarning(
    name: string,
    parent: OrganizationalUnit | null,
    unitId: string | null,
  ): Promise<string | null> {
    const parentId = parent?.id ?? null;
    const sibling = (await this.unitsRepository.findAll(true)).find(
      (other) => other.id !== unitId && other.isActive && other.parentId === parentId && sameUnitName(other.name, name),
    );
    return sibling ? duplicateSiblingWarning(sibling, parent?.name ?? null) : null;
  }

  /**
   * Sin hijas activas ni centros activos: se borra de verdad, o se archiva (is_active=false) si algo la referencia
   * (hijas o centros inactivos, historial de ubicación de algún centro…). Ver StructureRemovalService.
   */
  async remove(id: string, actor: AuthenticatedUser): Promise<StructureRemovalResultDto> {
    const unit = await this.requireUnit(id);
    const children = await this.unitsRepository.countActiveChildren(unit.id);
    if (children > 0) {
      throw new ApiException(
        ErrorCode.OrgUnitHasChildren,
        children === 1 ? 'La unidad tiene 1 unidad hija activa' : `La unidad tiene ${children} unidades hijas activas`,
        [{ field: 'activeChildren', message: String(children) }],
      );
    }
    const activeCenters = await this.unitsRepository.countActiveCostCenters(unit.id);
    if (activeCenters > 0) {
      throw new ApiException(
        ErrorCode.HasDependentEntities,
        activeCenters === 1
          ? 'La unidad tiene 1 centro de costo activo: muévalo a otra unidad o desactívelo antes de desactivar la unidad'
          : `La unidad tiene ${activeCenters} centros de costo activos: muévalos a otra unidad o desactívelos antes de desactivar la unidad`,
        [{ field: 'activeCostCenters', message: String(activeCenters) }],
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const verdict = decideUnitRemoval(await this.removal.inspectUnit(manager, unit.id));
      if (verdict.decision === 'BLOCKED') {
        throw new ApiException(ErrorCode.HasDependentEntities, verdict.reason ?? undefined);
      }
      if (verdict.decision === 'DELETE') {
        await this.removal.deleteUnit(manager, unit.id);
      } else {
        await manager.query('UPDATE organizational_unit SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [unit.id]);
        await this.history.record(
          manager,
          [
            {
              entityType: 'ORG_UNIT',
              entityId: unit.id,
              field: 'STATUS',
              oldValue: unit.isActive ? 'ACTIVE' : 'ARCHIVED',
              newValue: 'ARCHIVED',
            },
          ],
          { actorId: actor.id, source: 'MANUAL', reason: verdict.reason },
        );
      }
      await this.reconciler.reconcileWithin(
        manager,
        partialScope({ prefixes: [unit.codePrefix], unitIds: verdict.decision === 'DELETE' ? [] : [unit.id] }),
        {
          actorId: actor.id,
          reason: `Se ${verdict.decision === 'DELETE' ? 'eliminó' : 'archivó'} la unidad ${unitLabel(unit)}`,
          ip: null,
          userAgent: null,
        },
      );
      await this.auditLogsRepository.record(
        {
          action: verdict.decision === 'DELETE' ? AuditAction.OrgUnitDeleted : AuditAction.OrgUnitArchived,
          entityType: ORG_UNIT_ENTITY_TYPE,
          entityId: unit.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { code: unit.code, name: unit.name, codePrefix: unit.codePrefix, physical: verdict.decision === 'DELETE' },
        },
        manager,
      );
      return {
        deleted: verdict.decision === 'DELETE',
        archived: verdict.decision === 'ARCHIVE',
        reason: verdict.reason,
      };
    });
  }

  /** El prefijo de código de centros es único entre unidades activas (uq_org_unit_code_prefix_active). */
  private async assertPrefixFree(codePrefix: string, unitId: string | null): Promise<void> {
    const holder = await this.unitsRepository.findActiveByCodePrefix(codePrefix);
    if (holder && holder.id !== unitId) {
      throw new ApiException(
        ErrorCode.OrgUnitCodePrefixExists,
        `El prefijo ${codePrefix} ya es de la unidad ${holder.name}`,
        [{ field: 'codePrefix', message: holder.code }],
      );
    }
  }

  /**
   * Centro propio pedido en POST/PATCH; undefined si no se toca. Por código (prioridad): amarrado si existe activo; si
   * no, pendiente con advertencia (el conciliador lo amarra cuando el centro se cree o se reactive). Por id: debe
   * existir (404) y se guarda también su código.
   */
  private async chooseHeadCenter(dto: {
    readonly headCostCenterId?: string | null;
    readonly headCostCenterCode?: string | null;
  }): Promise<HeadCenterChoice | undefined> {
    if (dto.headCostCenterCode !== undefined) {
      if (dto.headCostCenterCode === null) {
        return { headCostCenterId: null, headCostCenterCode: null, warning: null };
      }
      const center = await this.unitsRepository.findCostCenterByCode(dto.headCostCenterCode);
      return center?.isActive
        ? { headCostCenterId: center.id, headCostCenterCode: dto.headCostCenterCode, warning: null }
        : {
            headCostCenterId: null,
            headCostCenterCode: dto.headCostCenterCode,
            warning: pendingHeadCenterMessage(dto.headCostCenterCode, Boolean(center)),
          };
    }
    if (dto.headCostCenterId === undefined) {
      return undefined;
    }
    if (dto.headCostCenterId === null) {
      return { headCostCenterId: null, headCostCenterCode: null, warning: null };
    }
    const code = await this.unitsRepository.costCenterCode(dto.headCostCenterId);
    if (code === null) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo propio indicado', [
        { field: 'headCostCenterId', message: dto.headCostCenterId },
      ]);
    }
    return { headCostCenterId: dto.headCostCenterId, headCostCenterCode: code, warning: null };
  }

  private async requireUnit(id: string): Promise<OrganizationalUnit> {
    const unit = await this.unitsRepository.findById(id);
    if (!unit) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return unit;
  }

  private async isAncestorOf(
    ancestorId: string,
    nodeId: string,
  ): Promise<boolean> {
    let current = await this.unitsRepository.findById(nodeId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = await this.unitsRepository.findById(current.parentId);
    }
    return false;
  }
}
