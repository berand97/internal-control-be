import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isOrgUnitCycle,
  isUniqueViolation,
} from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { checkUnitPrefix, suggestUnitPrefix } from '../../cost-centers/domain/org-chart-rules.js';
import type { UnitPrefixSuggestionDto } from '../dto/responses/unit-prefix-suggestion.response.dto.js';
import type { StructureRemovalResultDto } from '../../cost-centers/dto/responses/structure-removal.response.dto.js';
import {
  type OrgHistoryEntry,
  OrgStructureHistoryService,
} from '../../cost-centers/services/org-structure-history.service.js';
import { decideUnitRemoval, StructureRemovalService } from '../../cost-centers/services/structure-removal.service.js';
import { OrgUnitType } from '../enums/org-unit-type.enum.js';
import { CreateOrganizationalUnitDto } from '../dto/create-organizational-unit.dto.js';
import { QueryOrganizationalUnitsDto } from '../dto/query-organizational-units.dto.js';
import { OrganizationalUnitTreeResponseDto } from '../dto/responses/organizational-unit-tree.response.dto.js';
import { OrganizationalUnitResponseDto } from '../dto/responses/organizational-unit.response.dto.js';
import { UpdateOrganizationalUnitDto } from '../dto/update-organizational-unit.dto.js';
import type { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import type { OrganizationalUnitsRepository } from '../repositories/organizational-units.repository.interface.js';

const ORG_UNIT_ENTITY_TYPE = 'ORG_UNIT';

const toPathSegment = (code: string): string => code.toLowerCase();

const childPath = (parentPath: string | null, code: string): string =>
  parentPath ? `${parentPath}/${toPathSegment(code)}` : `/${toPathSegment(code)}`;

const buildTree = (
  units: ReadonlyArray<OrganizationalUnit>,
  parentId: string | null,
): ReadonlyArray<OrganizationalUnitTreeResponseDto> =>
  units
    .filter((unit) => unit.parentId === parentId)
    .map((unit) =>
      OrganizationalUnitTreeResponseDto.from(unit, buildTree(units, unit.id)),
    );

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
    return buildTree(all, unit.id);
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
  ): Promise<OrganizationalUnitResponseDto> {
    const parent = dto.parentId
      ? await this.requireUnit(dto.parentId)
      : null;
    this.assertCouncilWithoutPrefix(dto.type, dto.codePrefix ?? null);
    if (dto.codePrefix) {
      await this.assertPrefixInParent(dto.codePrefix, parent, null);
    }
    if (dto.codePrefix && (dto.isActive ?? true)) {
      await this.assertPrefixFree(dto.codePrefix, null);
    }
    if (dto.headCostCenterId) {
      await this.requireCostCenter(dto.headCostCenterId);
    }
    try {
      const unit = await this.unitsRepository.insert({
        parentId: parent?.id ?? null,
        code: dto.code,
        name: dto.name,
        unitType: dto.type,
        hierarchyLevel: parent ? parent.hierarchyLevel + 1 : 0,
        hierarchyPath: childPath(parent?.hierarchyPath ?? null, dto.code),
        isActive: dto.isActive ?? true,
        codePrefix: dto.codePrefix ?? null,
        ...(dto.relationType ? { relationType: dto.relationType } : {}),
        headCostCenterId: dto.headCostCenterId ?? null,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.OrgUnitCreated,
        entityType: ORG_UNIT_ENTITY_TYPE,
        entityId: unit.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { code: unit.code },
      });
      return OrganizationalUnitResponseDto.from(unit);
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
  ): Promise<OrganizationalUnitResponseDto> {
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
    if (nextPrefix && (nextPrefix !== unit.codePrefix || parentId !== unit.parentId)) {
      await this.assertPrefixInParent(nextPrefix, parent, unit.id);
    }
    if (nextPrefix && (dto.isActive ?? unit.isActive)) {
      await this.assertPrefixFree(nextPrefix, unit.id);
    }
    const previousParent = unit.parentId ? await this.unitsRepository.findById(unit.parentId) : null;

    if (dto.headCostCenterId) {
      await this.requireCostCenter(dto.headCostCenterId);
    }

    const nextCode = dto.code ?? unit.code;
    const nextPath = childPath(parent?.hierarchyPath ?? null, nextCode);
    const nextLevel = parent ? parent.hierarchyLevel + 1 : 0;
    const pathChanged = nextPath !== unit.hierarchyPath;

    try {
      await this.unitsRepository.update(unit.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { unitType: dto.type } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.codePrefix !== undefined ? { codePrefix: dto.codePrefix } : {}),
        ...(dto.parentId !== undefined ? { parentId } : {}),
        ...(dto.relationType !== undefined ? { relationType: dto.relationType } : {}),
        ...(dto.headCostCenterId !== undefined ? { headCostCenterId: dto.headCostCenterId } : {}),
        ...(pathChanged
          ? { hierarchyPath: nextPath, hierarchyLevel: nextLevel }
          : {}),
      });
      if (pathChanged && unit.hierarchyPath) {
        await this.unitsRepository.rewriteDescendantPaths(
          unit.hierarchyPath,
          nextPath,
          nextLevel - unit.hierarchyLevel,
        );
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.OrgUnitCodeAlreadyExists);
      }
      if (isOrgUnitCycle(error)) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      throw error;
    }

    await this.auditLogsRepository.record({
      action: AuditAction.OrgUnitUpdated,
      entityType: ORG_UNIT_ENTITY_TYPE,
      entityId: unit.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    const updated = await this.requireUnit(id);
    await this.recordHistory(unit, updated, previousParent, parent, actor);
    return OrganizationalUnitResponseDto.from(updated);
  }

  /** Historial de nombre, código, tipo, padre, prefijo, línea, centro propio y estado (org_structure_history). */
  private async recordHistory(
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
    const headChanged = before.headCostCenterId !== after.headCostCenterId;
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
        oldValue: headChanged ? await centerCode(before.headCostCenterId) : null,
        newValue: headChanged ? ((await centerCode(after.headCostCenterId)) ?? '(ninguno)') : null,
      },
      { entityType: 'ORG_UNIT', entityId: after.id, field: 'STATUS', oldValue: status(before.isActive), newValue: status(after.isActive) },
    ];
    await this.history.record(this.dataSource.manager, entries, { actorId: actor.id, source: 'MANUAL' });
  }

  private assertCouncilWithoutPrefix(type: OrgUnitType, codePrefix: string | null): void {
    if (type === OrgUnitType.Council && codePrefix) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Un consejo o comité no lleva prefijo: no recibe centros de costo', [
        { field: 'codePrefix', message: 'Sin prefijo para un consejo o comité' },
      ]);
    }
  }

  /**
   * El prefijo de una unidad empieza por el de su ancestro más cercano con prefijo y tiene un dígito más (4 → 41–49).
   * Sin ancestro con prefijo vale cualquiera. 400 ORG_UNIT_PREFIX_OUT_OF_PARENT con el rango esperado, salvo que
   * ninguna otra unidad activa tenga sus dígitos iniciales (checkUnitPrefix: 30 bajo la Académica sin unidad «3»).
   */
  private async assertPrefixInParent(
    codePrefix: string,
    parent: OrganizationalUnit | null,
    unitId: string | null,
  ): Promise<void> {
    let ancestor = parent;
    for (let depth = 0; ancestor && !ancestor.codePrefix && depth < 64; depth += 1) {
      ancestor = ancestor.parentId ? await this.unitsRepository.findById(ancestor.parentId) : null;
    }
    const expected = ancestor?.codePrefix ?? null;
    const others = new Set(
      (await this.unitsRepository.findAll(true)).flatMap((unit) =>
        unit.codePrefix && unit.id !== unitId && unit.codePrefix !== codePrefix ? [unit.codePrefix] : [],
      ),
    );
    const check = checkUnitPrefix(codePrefix, expected, others);
    if (check.level === 'ERROR') {
      throw new ApiException(ErrorCode.OrgUnitPrefixOutOfParent, check.message ?? undefined, [
        { field: 'codePrefix', message: `${expected ?? ''}0–${expected ?? ''}9` },
      ]);
    }
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

  private async requireCostCenter(id: string): Promise<void> {
    if (!(await this.unitsRepository.costCenterExists(id))) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo propio indicado', [
        { field: 'headCostCenterId', message: id },
      ]);
    }
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
