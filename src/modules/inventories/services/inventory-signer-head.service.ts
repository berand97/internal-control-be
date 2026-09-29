import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';

/** Aviso del cierre y del detalle: el acta OCI-21-37 no se puede emitir (no hay jefe que firme como ENCARGADO). */
export const ACT_CANNOT_BE_ISSUED = 'ACT_CANNOT_BE_ISSUED';

export interface InventoryWarning {
  readonly code: typeof ACT_CANNOT_BE_ISSUED;
  readonly message: string;
}

export interface HeadCandidate {
  readonly personId: string;
  readonly name: string;
}

export interface CloseSignerInput {
  readonly signerHeadPersonId?: string;
  readonly attendedByPersonId?: string;
  readonly attendedByName?: string;
}

const CURRENT_HEAD = 'h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())';

const PERSON_NAME = `nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')`;

/**
 * Firmante ENCARGADO del acta OCI-21-37 (decisión del desarrollador): siempre el jefe vigente del centro de costo de
 * la toma, haya estado o no en sitio, resuelto al CERRAR (un solo jefe vigente: él; varios: se elige; ninguno: el
 * cierre procede, pero el acta no se emite hasta indicarlo — aviso ACT_CANNOT_BE_ISSUED —). Quién atendió por el área
 * es un dato aparte y solo informativo (persona del sistema o texto libre): no firma ni se valida contra jefaturas.
 * Una toma que no es de un centro de costo (ubicación, unidad, global) no tiene jefe que firme: mismo aviso.
 */
@Injectable()
export class InventorySignerHeadService {
  constructor(private readonly dataSource: DataSource) {}

  private centerOf(inventory: PhysicalInventory): string | null {
    return inventory.scopeType === InventoryScopeType.CostCenter ? inventory.scopeId : null;
  }

  /** Jefes vigentes (persona activa) del centro de la toma; vacío si la toma no es de un centro. */
  async candidates(inventory: PhysicalInventory, manager: EntityManager = this.dataSource.manager): Promise<HeadCandidate[]> {
    const center = this.centerOf(inventory);
    if (!center) {
      return [];
    }
    return (await manager.query(
      `SELECT DISTINCT p.id AS "personId", ${PERSON_NAME} AS name
       FROM cost_center_head h JOIN person p ON p.id = h.person_id AND p.is_active
       WHERE h.cost_center_id = $1 AND ${CURRENT_HEAD}
       ORDER BY name, p.id`,
      [center],
    )) as HeadCandidate[];
  }

  /**
   * Al cerrar (en la transacción del cierre): valida y deja en `inventory` quién firma como ENCARGADO y quién atendió.
   * 400 VALIDATION_FAILED si el elegido no es jefe vigente, si hay varios y no se eligió, o si «atendió» trae persona
   * y texto a la vez.
   */
  async applyOnClose(
    manager: EntityManager,
    inventory: PhysicalInventory,
    input: CloseSignerInput,
    actor: AuthenticatedUser,
  ): Promise<void> {
    if (input.attendedByPersonId && input.attendedByName !== undefined) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Quién atendió por el área es una persona del sistema o un nombre, no ambos', [
        { field: 'attendedByName', message: 'No se envía junto con attendedByPersonId' },
      ]);
    }
    if (input.attendedByPersonId) {
      const [person] = (await manager.query('SELECT 1 FROM person WHERE id = $1', [input.attendedByPersonId])) as unknown[];
      if (!person) {
        throw new ApiException(ErrorCode.ValidationFailed, 'La persona que atendió por el área no existe', [
          { field: 'attendedByPersonId', message: 'No existe' },
        ]);
      }
    }
    const candidates = await this.candidates(inventory, manager);
    const signer = this.pick(inventory, candidates, input.signerHeadPersonId);
    const now = new Date();
    inventory.signerHeadPersonId = signer;
    inventory.signerHeadRecordedAt = signer ? now : null;
    inventory.signerHeadRecordedBy = signer ? actor.id : null;
    inventory.attendedByPersonId = input.attendedByPersonId ?? null;
    inventory.attendedByName = input.attendedByName?.trim() || null;
  }

  private pick(inventory: PhysicalInventory, candidates: ReadonlyArray<HeadCandidate>, chosen: string | undefined): string | null {
    if (chosen) {
      if (!candidates.some((candidate) => candidate.personId === chosen)) {
        throw new ApiException(
          ErrorCode.ValidationFailed,
          this.centerOf(inventory)
            ? 'Quien firma como ENCARGADO debe ser jefe vigente del centro de costo de la toma'
            : 'La toma no es de un centro de costo: no hay jefe que firme como ENCARGADO',
          [{ field: 'signerHeadPersonId', message: 'No es jefe vigente del centro de la toma (GET /inventories/:id/head-candidates)' }],
        );
      }
      return chosen;
    }
    if (candidates.length > 1) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        `El centro de la toma tiene ${candidates.length} jefes vigentes: indique cuál firma el acta como ENCARGADO`,
        [{ field: 'signerHeadPersonId', message: 'Obligatorio: elija uno de GET /inventories/:id/head-candidates' }],
      );
    }
    return candidates[0]?.personId ?? null;
  }

  /**
   * Después del cierre, cuando el centro ya tiene jefe (o para corregir cuál firma): solo con la toma CLOSED o
   * RECONCILED y el acta aún sin encolar. Luego se encola con POST /inventories/:id/act/enqueue (si ya está conciliada).
   */
  async assign(inventoryId: string, signerHeadPersonId: string, actor: AuthenticatedUser): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const inventory = await manager
        .getRepository(PhysicalInventory)
        .findOne({ where: { id: inventoryId }, lock: { mode: 'pessimistic_write' } });
      if (!inventory) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (
        (inventory.status !== InventoryStatus.Closed && inventory.status !== InventoryStatus.Reconciled) ||
        inventory.actRequestId
      ) {
        throw new ApiException(
          ErrorCode.InvalidState,
          'El firmante ENCARGADO se indica con la toma cerrada o conciliada y el acta aún sin encolar',
        );
      }
      inventory.signerHeadPersonId = this.pick(inventory, await this.candidates(inventory, manager), signerHeadPersonId);
      inventory.signerHeadRecordedAt = new Date();
      inventory.signerHeadRecordedBy = actor.id;
      await manager.getRepository(PhysicalInventory).save(inventory);
    });
  }

  /** Para el detalle: quién firma, quién atendió, si el acta se puede emitir y los avisos. */
  async view(inventory: PhysicalInventory) {
    const names = (await this.dataSource.query(
      `SELECT p.id, ${PERSON_NAME} AS name FROM person p WHERE p.id = ANY($1::uuid[])`,
      [[inventory.signerHeadPersonId, inventory.attendedByPersonId].filter((id): id is string => !!id)],
    )) as Array<{ id: string; name: string | null }>;
    const nameOf = (id: string | null) => names.find((row) => row.id === id)?.name ?? '';
    const actIssuable = inventory.signerHeadPersonId !== null || inventory.actRequestId !== null;
    const closed = inventory.status === InventoryStatus.Closed || inventory.status === InventoryStatus.Reconciled;
    const warnings: InventoryWarning[] = closed && !actIssuable ? [await this.warning(inventory)] : [];
    return {
      signerHead: inventory.signerHeadPersonId
        ? { personId: inventory.signerHeadPersonId, name: nameOf(inventory.signerHeadPersonId) }
        : null,
      attendedBy: inventory.attendedByPersonId
        ? { personId: inventory.attendedByPersonId, name: nameOf(inventory.attendedByPersonId) }
        : inventory.attendedByName
          ? { personId: null, name: inventory.attendedByName }
          : null,
      actIssuable,
      warnings,
    };
  }

  /** Nombre de quién atendió (persona o texto) para el acta; null si no se indicó. */
  async attendedName(manager: EntityManager, inventory: PhysicalInventory): Promise<string | null> {
    if (inventory.attendedByName) {
      return inventory.attendedByName;
    }
    if (!inventory.attendedByPersonId) {
      return null;
    }
    const [row] = (await manager.query(`SELECT ${PERSON_NAME} AS name FROM person p WHERE p.id = $1`, [
      inventory.attendedByPersonId,
    ])) as Array<{ name: string | null }>;
    return row?.name ?? null;
  }

  async warning(inventory: PhysicalInventory, manager: EntityManager = this.dataSource.manager): Promise<InventoryWarning> {
    const center = this.centerOf(inventory);
    if (!center) {
      return {
        code: ACT_CANNOT_BE_ISSUED,
        message:
          'La toma no es de un centro de costo: no hay jefe de centro que firme el acta OCI-21-37 como ENCARGADO, así que el acta no se podrá emitir.',
      };
    }
    const [row] = (await manager.query(`SELECT external_code || ' ' || name AS label FROM cost_center WHERE id = $1`, [center])) as Array<{
      label: string;
    }>;
    return {
      code: ACT_CANNOT_BE_ISSUED,
      message:
        `El centro de costo ${row?.label ?? ''} no tiene jefe vigente: el acta OCI-21-37 no se podrá emitir hasta asignarle un jefe, ` +
        'indicarlo en la toma (PUT /inventories/:id/signer-head) y encolar el acta.',
    };
  }
}
