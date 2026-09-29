import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { ITEM_ACT_CENTER_SQL } from '../domain/inventory-act.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryAct } from '../entities/physical-inventory-act.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';

/** Aviso del cierre y del detalle: un acta OCI-21-37 no se puede emitir (no hay jefe que firme como ENCARGADO). */
export const ACT_CANNOT_BE_ISSUED = 'ACT_CANNOT_BE_ISSUED';

export interface InventoryWarning {
  readonly code: typeof ACT_CANNOT_BE_ISSUED;
  readonly message: string;
  /** Centro del acta que no se puede emitir. */
  readonly costCenterId: string | null;
}

export interface HeadCandidate {
  readonly personId: string;
  readonly name: string;
}

export interface CostCenterRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface CenterHeadCandidates {
  readonly costCenter: CostCenterRef;
  readonly candidates: HeadCandidate[];
}

export interface SignerHeadChoice {
  readonly costCenterId: string;
  readonly personId: string;
}

export interface ActAttendedByInput {
  readonly costCenterId: string;
  readonly personId?: string;
  readonly name?: string;
}

export interface CloseSignerInput {
  /** Compatibilidad: firmante de la única acta de una toma de un solo centro. */
  readonly signerHeadPersonId?: string;
  /** Quién atendió, para todas las actas que no lo indiquen en attendedBy. */
  readonly attendedByPersonId?: string;
  readonly attendedByName?: string;
  readonly signerHeads?: ReadonlyArray<SignerHeadChoice>;
  readonly attendedBy?: ReadonlyArray<ActAttendedByInput>;
}

const CURRENT_HEAD = 'h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())';

const PERSON_NAME = `nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')`;

const ITEM_JOINS = `physical_inventory_item i
  LEFT JOIN asset a ON a.id = i.asset_id
  LEFT JOIN asset ra ON ra.id = i.resolved_asset_id`;

const fail = (message: string, field: string, detail: string): never => {
  throw new ApiException(ErrorCode.ValidationFailed, message, [{ field, message: detail }]);
};

/**
 * Actas OCI-21-37 de una toma, una por centro de costo presente en sus ítems (decisión del desarrollador: la ubicación
 * define el trabajo de campo, no el acta). Cada acta la firma como ENCARGADO el jefe vigente de SU centro, haya estado o
 * no en sitio, resuelto al CERRAR: un solo jefe vigente, él; varios, se elige (signerHeads); ninguno, el cierre procede
 * y esa acta no se emite hasta indicarlo (aviso ACT_CANNOT_BE_ISSUED), sin bloquear las demás. Quién atendió por el área
 * es un dato de cada acta, solo informativo (en una toma por ubicación cada área pudo tener su encargado).
 */
@Injectable()
export class InventorySignerHeadService {
  constructor(private readonly dataSource: DataSource) {}

  /** Centros de costo de las actas según los ítems vigentes (alcance COST_CENTER: siempre el suyo), sin repetir. */
  async centersOf(manager: EntityManager, inventory: PhysicalInventory): Promise<string[]> {
    const rows = (await manager.query(
      `SELECT DISTINCT center FROM (
         SELECT ${ITEM_ACT_CENTER_SQL} AS center FROM ${ITEM_JOINS}
         WHERE i.inventory_id = $1 AND i.voided_at IS NULL
         UNION ALL
         SELECT $3::uuid WHERE $2::text = 'COST_CENTER'
       ) x WHERE center IS NOT NULL`,
      [inventory.id, inventory.scopeType, inventory.scopeId],
    )) as Array<{ center: string }>;
    return rows.map((row) => row.center);
  }

  /** Ítems vigentes que no van a ninguna acta (sobrante sin activo ni resolución, o activo sin centro en la foto). */
  async unassignedItems(inventory: PhysicalInventory, manager: EntityManager = this.dataSource.manager): Promise<number> {
    const [row] = (await manager.query(
      `SELECT count(*)::int AS total FROM ${ITEM_JOINS}
       WHERE i.inventory_id = $1 AND i.voided_at IS NULL AND (${ITEM_ACT_CENTER_SQL}) IS NULL`,
      [inventory.id, inventory.scopeType, inventory.scopeId],
    )) as Array<{ total: number }>;
    return row?.total ?? 0;
  }

  async costCenters(manager: EntityManager, ids: ReadonlyArray<string>): Promise<Map<string, CostCenterRef>> {
    const rows = (await manager.query(
      `SELECT id, external_code AS code, name FROM cost_center WHERE id = ANY($1::uuid[])`,
      [[...ids]],
    )) as CostCenterRef[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Jefes vigentes (persona activa) de cada centro; un centro sin jefes queda con lista vacía. */
  async candidatesByCenter(
    manager: EntityManager,
    centers: ReadonlyArray<string>,
  ): Promise<Map<string, HeadCandidate[]>> {
    const rows = (await manager.query(
      `SELECT DISTINCT h.cost_center_id AS "costCenterId", p.id AS "personId", ${PERSON_NAME} AS name
       FROM cost_center_head h JOIN person p ON p.id = h.person_id AND p.is_active
       WHERE h.cost_center_id = ANY($1::uuid[]) AND ${CURRENT_HEAD}
       ORDER BY name, p.id`,
      [[...centers]],
    )) as Array<HeadCandidate & { costCenterId: string }>;
    const byCenter = new Map<string, HeadCandidate[]>(centers.map((center) => [center, []]));
    for (const row of rows) {
      byCenter.get(row.costCenterId)?.push({ personId: row.personId, name: row.name });
    }
    return byCenter;
  }

  /**
   * Jefes candidatos por centro de la toma: los centros de sus actas si ya existen (cerrada), si no los de sus ítems.
   * Sirve para el formulario del cierre y para indicar el firmante después.
   */
  async candidatesFor(inventory: PhysicalInventory): Promise<CenterHeadCandidates[]> {
    const manager = this.dataSource.manager;
    const rows = await manager.getRepository(PhysicalInventoryAct).find({ where: { inventoryId: inventory.id } });
    const centers = [
      ...new Set([
        ...rows.map((row) => row.costCenterId).filter((id): id is string => id !== null),
        ...(rows.length > 0 ? [] : await this.centersOf(manager, inventory)),
      ]),
    ];
    const refs = await this.costCenters(manager, centers);
    const candidates = await this.candidatesByCenter(manager, centers);
    return centers
      .map((center) => ({
        costCenter: refs.get(center) ?? { id: center, code: '', name: '' },
        candidates: candidates.get(center) ?? [],
      }))
      .sort((left, right) => left.costCenter.code.localeCompare(right.costCenter.code));
  }

  /** Compatibilidad (GET /inventories/:id/head-candidates): los jefes de la única acta; vacío con varios centros. */
  async singleCenterCandidates(inventory: PhysicalInventory): Promise<HeadCandidate[]> {
    const centers = await this.candidatesFor(inventory);
    return centers.length === 1 ? (centers[0]?.candidates ?? []) : [];
  }

  /**
   * Al cerrar (en la transacción del cierre): crea una fila por centro con quién firma como ENCARGADO y quién atendió.
   * 400 VALIDATION_FAILED si un elegido no es jefe vigente de su centro, si un centro tiene varios jefes y no se eligió,
   * si se elige para un centro que no está en la toma, o si «atendió» trae persona y texto a la vez.
   */
  async applyOnClose(
    manager: EntityManager,
    inventory: PhysicalInventory,
    input: CloseSignerInput,
    actor: AuthenticatedUser,
  ): Promise<PhysicalInventoryAct[]> {
    const centers = await this.centersOf(manager, inventory);
    const choices = this.choices(centers, input);
    const attended = await this.attended(manager, centers, input);
    const candidates = await this.candidatesByCenter(manager, centers);
    const refs = await this.costCenters(manager, centers);
    const unchosen: string[] = [];
    const now = new Date();
    const rows = centers.map((center) => {
      const options = candidates.get(center) ?? [];
      const chosen = choices.get(center);
      if (chosen && !options.some((option) => option.personId === chosen)) {
        fail(
          `Quien firma el acta del centro ${refs.get(center)?.code ?? ''} como ENCARGADO debe ser jefe vigente de ese centro`,
          centers.length === 1 && input.signerHeadPersonId ? 'signerHeadPersonId' : 'signerHeads',
          'No es jefe vigente del centro (GET /inventories/:id/acts/head-candidates)',
        );
      }
      if (!chosen && options.length > 1) {
        unchosen.push(center);
      }
      const signer = chosen ?? (options.length === 1 ? (options[0]?.personId ?? null) : null);
      const who = attended.get(center) ?? { personId: null, name: null };
      return manager.getRepository(PhysicalInventoryAct).create({
        inventoryId: inventory.id,
        costCenterId: center,
        signerHeadPersonId: signer,
        signerHeadRecordedAt: signer ? now : null,
        signerHeadRecordedBy: signer ? actor.id : null,
        attendedByPersonId: who.personId,
        attendedByName: who.name,
        documentRequestId: null,
        documentId: null,
        blockedCode: null,
        blockedMessage: null,
        blockedAt: null,
      });
    });
    if (unchosen.length > 0) {
      const single = centers.length === 1;
      throw new ApiException(
        ErrorCode.ValidationFailed,
        single
          ? `El centro de la toma tiene ${candidates.get(unchosen[0] as string)?.length ?? 0} jefes vigentes: indique cuál firma el acta como ENCARGADO`
          : 'Algunos centros de la toma tienen varios jefes vigentes: indique cuál firma cada acta como ENCARGADO',
        unchosen.map((center) => ({
          field: single ? 'signerHeadPersonId' : `signerHeads.${center}`,
          message: `${refs.get(center)?.code ?? center}: elija uno de GET /inventories/:id/acts/head-candidates`,
        })),
      );
    }
    return manager.getRepository(PhysicalInventoryAct).save(rows);
  }

  private choices(centers: ReadonlyArray<string>, input: CloseSignerInput): Map<string, string> {
    const choices = new Map<string, string>();
    if (input.signerHeadPersonId) {
      if (input.signerHeads?.length) {
        fail('Indique el firmante con signerHeads o con signerHeadPersonId, no ambos', 'signerHeadPersonId', 'No junto con signerHeads');
      }
      if (centers.length !== 1) {
        fail(
          `La toma tiene ${centers.length} centros de costo (un acta por centro): indique el firmante de cada uno en signerHeads`,
          'signerHeadPersonId',
          'Use signerHeads [{ costCenterId, personId }]',
        );
      }
      choices.set(centers[0] as string, input.signerHeadPersonId);
    }
    for (const choice of input.signerHeads ?? []) {
      if (!centers.includes(choice.costCenterId)) {
        fail('El centro indicado no tiene acta en esta toma', `signerHeads.${choice.costCenterId}`, 'No es un centro de la toma');
      }
      if (choices.has(choice.costCenterId)) {
        fail('Un centro con dos firmantes', `signerHeads.${choice.costCenterId}`, 'Repetido');
      }
      choices.set(choice.costCenterId, choice.personId);
    }
    return choices;
  }

  /** Quién atendió por centro: el de attendedBy para ese centro o, si no, el general de la toma. */
  private async attended(
    manager: EntityManager,
    centers: ReadonlyArray<string>,
    input: CloseSignerInput,
  ): Promise<Map<string, { personId: string | null; name: string | null }>> {
    const general = this.who(input.attendedByPersonId, input.attendedByName, 'attendedByName');
    const byCenter = new Map<string, { personId: string | null; name: string | null }>();
    for (const entry of input.attendedBy ?? []) {
      if (!centers.includes(entry.costCenterId)) {
        fail('El centro indicado no tiene acta en esta toma', `attendedBy.${entry.costCenterId}`, 'No es un centro de la toma');
      }
      if (byCenter.has(entry.costCenterId)) {
        fail('Un centro con dos personas que atendieron', `attendedBy.${entry.costCenterId}`, 'Repetido');
      }
      byCenter.set(entry.costCenterId, this.who(entry.personId, entry.name, `attendedBy.${entry.costCenterId}`));
    }
    const persons = [general.personId, ...[...byCenter.values()].map((value) => value.personId)].filter(
      (id): id is string => !!id,
    );
    if (persons.length > 0) {
      const found = (await manager.query('SELECT id FROM person WHERE id = ANY($1::uuid[])', [persons])) as Array<{
        id: string;
      }>;
      if (found.length < new Set(persons).size) {
        fail('La persona que atendió por el área no existe', 'attendedByPersonId', 'No existe');
      }
    }
    return new Map(centers.map((center) => [center, byCenter.get(center) ?? general]));
  }

  private who(personId: string | undefined, name: string | undefined, field: string) {
    if (personId && name !== undefined) {
      fail('Quién atendió por el área es una persona del sistema o un nombre, no ambos', field, 'No se envía junto con la persona');
    }
    return { personId: personId ?? null, name: name?.trim() || null };
  }

  /**
   * Alinea las actas con los ítems (al aprobar la conciliación y al resolver un sobrante con la toma cerrada): un
   * centro nuevo (p. ej. el del activo creado desde un sobrante) recibe su acta con su único jefe vigente como
   * firmante (con varios o ninguno queda sin firmante); un acta sin ítems y sin encolar se quita (salvo la del centro
   * de una toma COST_CENTER).
   */
  async sync(manager: EntityManager, inventory: PhysicalInventory, actor: AuthenticatedUser): Promise<void> {
    const repository = manager.getRepository(PhysicalInventoryAct);
    const centers = await this.centersOf(manager, inventory);
    const rows = await repository.find({ where: { inventoryId: inventory.id } });
    const stale = rows.filter(
      (row) => row.costCenterId !== null && !row.documentRequestId && !centers.includes(row.costCenterId),
    );
    if (stale.length > 0) {
      await repository.delete(stale.map((row) => row.id));
    }
    const existing = new Set(rows.map((row) => row.costCenterId));
    // Una toma migrada con su acta única (sin centro) no recibe actas por centro.
    if (existing.has(null)) {
      return;
    }
    const missing = centers.filter((center) => !existing.has(center));
    if (missing.length === 0) {
      return;
    }
    const candidates = await this.candidatesByCenter(manager, missing);
    const now = new Date();
    await repository.save(
      missing.map((center) => {
        const options = candidates.get(center) ?? [];
        const signer = options.length === 1 ? (options[0]?.personId ?? null) : null;
        return repository.create({
          inventoryId: inventory.id,
          costCenterId: center,
          signerHeadPersonId: signer,
          signerHeadRecordedAt: signer ? now : null,
          signerHeadRecordedBy: signer ? actor.id : null,
          attendedByPersonId: null,
          attendedByName: null,
          documentRequestId: null,
          documentId: null,
          blockedCode: null,
          blockedMessage: null,
          blockedAt: null,
        });
      }),
    );
  }

  /**
   * Después del cierre, cuando el centro ya tiene jefe (o para corregir cuál firma): solo con la toma CLOSED o
   * RECONCILED y el acta de ese centro aún sin encolar. costCenterId null (compatibilidad, PUT /inventories/:id/
   * signer-head): la única acta de la toma. Luego se encola con POST /inventories/:id/acts/:costCenterId/enqueue.
   */
  async assign(
    inventoryId: string,
    costCenterId: string | null,
    signerHeadPersonId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const inventory = await manager
        .getRepository(PhysicalInventory)
        .findOne({ where: { id: inventoryId }, lock: { mode: 'pessimistic_write' } });
      if (!inventory) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      const row = await this.actFor(manager, inventory.id, costCenterId);
      if (
        (inventory.status !== InventoryStatus.Closed && inventory.status !== InventoryStatus.Reconciled) ||
        row.documentRequestId ||
        !row.costCenterId
      ) {
        throw new ApiException(
          ErrorCode.InvalidState,
          'El firmante ENCARGADO se indica con la toma cerrada o conciliada y el acta aún sin encolar',
        );
      }
      const options = (await this.candidatesByCenter(manager, [row.costCenterId])).get(row.costCenterId) ?? [];
      if (!options.some((option) => option.personId === signerHeadPersonId)) {
        fail(
          'Quien firma como ENCARGADO debe ser jefe vigente del centro de costo del acta',
          'signerHeadPersonId',
          'No es jefe vigente del centro (GET /inventories/:id/acts/head-candidates)',
        );
      }
      row.signerHeadPersonId = signerHeadPersonId;
      row.signerHeadRecordedAt = new Date();
      row.signerHeadRecordedBy = actor.id;
      row.updatedAt = new Date();
      await manager.getRepository(PhysicalInventoryAct).save(row);
    });
  }

  /**
   * El acta de un centro de la toma (bloqueada). costCenterId null: la única acta (compatibilidad); con varias,
   * 406 INVALID_STATE pidiendo el centro. 404 si la toma no tiene acta para ese centro.
   */
  async actFor(manager: EntityManager, inventoryId: string, costCenterId: string | null): Promise<PhysicalInventoryAct> {
    const rows = await manager.getRepository(PhysicalInventoryAct).find({
      where: costCenterId ? { inventoryId, costCenterId } : { inventoryId },
      lock: { mode: 'pessimistic_write' },
    });
    if (rows.length === 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'La toma no tiene acta para ese centro de costo');
    }
    if (rows.length > 1) {
      throw new ApiException(
        ErrorCode.InvalidState,
        `La toma tiene ${rows.length} actas (una por centro de costo): indique el centro (/inventories/:id/acts/:costCenterId/…)`,
      );
    }
    return rows[0] as PhysicalInventoryAct;
  }

  /** Aviso de un acta sin firmante: el centro no tiene jefe vigente o tiene varios y no se eligió. */
  warning(center: CostCenterRef | null, candidates: number): InventoryWarning {
    const label = center ? `${center.code} ${center.name}` : '';
    return {
      code: ACT_CANNOT_BE_ISSUED,
      costCenterId: center?.id ?? null,
      message:
        candidates > 1
          ? `El centro de costo ${label} tiene ${candidates} jefes vigentes y no se eligió cuál firma: su acta OCI-21-37 no se ` +
            'emitirá hasta indicarlo (PUT /inventories/:id/acts/:costCenterId/signer-head) y encolarla. Las demás actas siguen.'
          : `El centro de costo ${label} no tiene jefe vigente: su acta OCI-21-37 no se podrá emitir hasta asignarle un jefe, ` +
            'indicarlo (PUT /inventories/:id/acts/:costCenterId/signer-head) y encolarla. Las demás actas siguen.',
    };
  }

  /** Nombres de personas (firmantes y quién atendió) por id. */
  async personNames(manager: EntityManager, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = (await manager.query(`SELECT p.id, ${PERSON_NAME} AS name FROM person p WHERE p.id = ANY($1::uuid[])`, [
      wanted,
    ])) as Array<{ id: string; name: string | null }>;
    return new Map(rows.map((row) => [row.id, row.name ?? '']));
  }

  /** Nombre de quién atendió el área del acta (persona o texto) para el acta; null si no se indicó. */
  async attendedName(manager: EntityManager, act: PhysicalInventoryAct): Promise<string | null> {
    if (act.attendedByName) {
      return act.attendedByName;
    }
    if (!act.attendedByPersonId) {
      return null;
    }
    return (await this.personNames(manager, [act.attendedByPersonId])).get(act.attendedByPersonId) ?? null;
  }
}
