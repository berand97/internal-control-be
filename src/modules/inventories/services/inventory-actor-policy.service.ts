import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { scopeSql } from '../domain/inventory-scope-sql.js';
import type { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';

/** Quien programa tomas puede ejecutar cualquiera; los demás, solo la suya. */
export const INVENTORY_OVERRIDE_PERMISSION = 'inventory:create:global';

export type InventoryConflictReason = 'COST_CENTER_HEAD' | 'ASSET_CUSTODIAN';

type InventoryRef = Pick<PhysicalInventory, 'id' | 'responsibleUserId' | 'scopeType' | 'scopeId'>;

/**
 * Regla única de quién opera una toma (iniciar, verificar, faltante, sobrante, categoría, corrección, anulación y
 * cierre):
 * 1. el responsable de la toma (responsible_user_id) o quien tenga inventory:create:global;
 * 2. y nunca el auditado: ni un jefe vigente (cost_center_head) de un centro auditado, ni el custodio de un activo
 *    del alcance (asset.current_responsible_id = persona del usuario; el mismo vínculo persona-usuario que usan las
 *    actas de entrega y los préstamos). Centros auditados: los de los activos del alcance (sin dados de baja), los de
 *    la foto de la toma y, en alcance COST_CENTER, el centro mismo. Activos: los del alcance hoy y los de la foto.
 * El permiso de ruta (inventory:execute:global) lo sigue exigiendo el guard; esto va después.
 */
@Injectable()
export class InventoryActorPolicy {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
  ) {}

  async assertCanOperate(
    inventory: InventoryRef,
    actor: AuthenticatedUser,
    manager?: EntityManager,
  ): Promise<void> {
    const isResponsible = inventory.responsibleUserId === actor.id;
    if (!isResponsible && !(await this.permissions.userHasPermission(actor.id, INVENTORY_OVERRIDE_PERMISSION))) {
      throw new ApiException(ErrorCode.InventoryActorNotAllowed);
    }
    const reason = await this.conflictOf(inventory, actor.id, manager);
    if (reason === 'COST_CENTER_HEAD') {
      throw new ApiException(
        ErrorCode.InventoryConflictOfInterest,
        'Eres jefe vigente de un centro de costo que audita esta toma: no puedes ejecutarla, corregirla ni cerrarla',
        [{ field: 'reason', message: reason }],
      );
    }
    if (reason === 'ASSET_CUSTODIAN') {
      throw new ApiException(
        ErrorCode.InventoryConflictOfInterest,
        'Eres custodio de activos que audita esta toma: no puedes ejecutarla, corregirla ni cerrarla',
        [{ field: 'reason', message: reason }],
      );
    }
  }

  /** null si el usuario no es auditado por la toma. */
  async conflictOf(
    inventory: InventoryRef,
    userId: string,
    manager?: EntityManager,
  ): Promise<InventoryConflictReason | null> {
    const scoped = scopeSql('a', inventory.scopeType, inventory.scopeId, 4);
    const scopeCenter = inventory.scopeType === InventoryScopeType.CostCenter ? inventory.scopeId : null;
    const rows: unknown = await (manager ?? this.dataSource).query(
      `
      WITH me AS (
        SELECT person_id FROM app_user WHERE id = $1 AND person_id IS NOT NULL
      ),
      audited_assets AS (
        SELECT a.current_cost_center_id AS cost_center_id, a.current_responsible_id AS responsible_id
        FROM asset a
        WHERE a.operational_status <> 'WRITTEN_OFF' AND (${scoped.sql})
        UNION
        SELECT a.current_cost_center_id, a.current_responsible_id
        FROM physical_inventory_item i
        JOIN asset a ON a.id = i.asset_id
        WHERE i.inventory_id = $2 AND i.verification_result <> 'SURPLUS'
      ),
      audited_centers AS (
        SELECT cost_center_id AS id FROM audited_assets
        UNION
        SELECT expected_cost_center_id FROM physical_inventory_item
        WHERE inventory_id = $2 AND expected_cost_center_id IS NOT NULL
        UNION
        SELECT $3::uuid WHERE $3::uuid IS NOT NULL
      )
      SELECT
        EXISTS (
          SELECT 1 FROM cost_center_head h JOIN me ON me.person_id = h.person_id
          WHERE h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())
            AND h.cost_center_id IN (SELECT id FROM audited_centers)
        ) AS head,
        EXISTS (
          SELECT 1 FROM audited_assets s JOIN me ON me.person_id = s.responsible_id
        ) AS custodian
      `,
      [userId, inventory.id, scopeCenter, ...scoped.params],
    );
    const row = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
      ? (rows[0] as { head?: unknown; custodian?: unknown })
      : null;
    if (row?.head === true) {
      return 'COST_CENTER_HEAD';
    }
    if (row?.custodian === true) {
      return 'ASSET_CUSTODIAN';
    }
    return null;
  }
}
