import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { SetLocationCompanionDto } from '../dto/inventory-companion.dto.js';
import { InventoryLocationCompanion } from '../entities/inventory-location-companion.entity.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { InventoryActorPolicy } from './inventory-actor-policy.service.js';

@Injectable()
export class InventoryLocationCompanionService {
  constructor(
    @InjectRepository(InventoryLocationCompanion)
    private readonly companions: Repository<InventoryLocationCompanion>,
    @InjectRepository(PhysicalInventory)
    private readonly inventories: Repository<PhysicalInventory>,
    private readonly dataSource: DataSource,
    private readonly actorPolicy: InventoryActorPolicy,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async get(inventoryId: string, locationId: string) {
    await this.requireInventory(inventoryId);
    const row = await this.companions.findOne({ where: { inventoryId, locationId } });
    const dto = this.toDto(inventoryId, locationId, row);
    if (dto.companion && !dto.companion.name && row?.personId) {
      dto.companion.name = (await this.personName(row.personId)) ?? '';
    }
    return dto;
  }

  async set(inventoryId: string, locationId: string, dto: SetLocationCompanionDto, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(inventoryId);
    if (inventory.status !== InventoryStatus.InProgress) {
      throw new ApiException(ErrorCode.InvalidState, 'El acompañante se registra con la toma en curso.');
    }
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const who = this.resolveWho(dto);
    const [location] = (await this.dataSource.query(
      'SELECT id FROM location WHERE id = $1 AND is_active',
      [locationId],
    )) as Array<{ id: string }>;
    if (!location) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (who.personId) {
      const [person] = (await this.dataSource.query(
        'SELECT id FROM person WHERE id = $1 AND is_active',
        [who.personId],
      )) as Array<{ id: string }>;
      if (!person) {
        throw new ApiException(ErrorCode.ValidationFailed, 'No encontramos a esa persona.', [
          { field: 'personId', message: 'No encontramos a esta persona.' },
        ]);
      }
    }
    const previous = await this.companions.findOne({ where: { inventoryId, locationId } });
    const now = new Date();
    let displayName = who.name;
    if (who.personId && !displayName) {
      displayName = await this.personName(who.personId);
    }
    const saved = await this.companions.save(
      this.companions.create({
        inventoryId,
        locationId,
        personId: who.personId,
        name: who.personId ? null : who.name,
        recordedAt: now,
        recordedBy: actor.id,
      }),
    );
    await this.auditLogs.record({
      action: AuditAction.InventoryCompanionSet,
      entityType: 'INVENTORY',
      entityId: inventoryId,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: {
        locationId,
        from: previous ? { personId: previous.personId, name: previous.name } : null,
        to: { personId: saved.personId, name: saved.name ?? displayName },
      },
    });
    const dtoOut = this.toDto(inventoryId, locationId, saved);
    if (dtoOut.companion && !dtoOut.companion.name && displayName) {
      dtoOut.companion.name = displayName;
    }
    return dtoOut;
  }

  async stampItem(item: PhysicalInventoryItem, locationId: string | null): Promise<void> {
    if (!locationId) {
      return;
    }
    const row = await this.companions.findOne({
      where: { inventoryId: item.inventoryId, locationId },
    });
    if (!row) {
      return;
    }
    item.companionPersonId = row.personId;
    item.companionName = row.name ?? (await this.personName(row.personId));
  }

  async companionsForCenter(
    inventoryId: string,
    costCenterId: string,
  ): Promise<Array<{ personId: string | null; name: string }>> {
    const rows = (await this.dataSource.query(
      `WITH stamped AS (
         SELECT
           i.companion_person_id AS person_id,
           coalesce(
             nullif(trim(i.companion_name), ''),
             trim(p.first_name || ' ' || p.last_name)
           ) AS name
         FROM physical_inventory_item i
         LEFT JOIN person p ON p.id = i.companion_person_id
         WHERE i.inventory_id = $1
           AND i.voided_at IS NULL
           AND (
             i.expected_cost_center_id = $2
             OR (i.verification_result = 'SURPLUS' AND i.surplus_cost_center_id = $2)
           )
           AND (i.companion_person_id IS NOT NULL OR nullif(trim(i.companion_name), '') IS NOT NULL)
       ),
       counted AS (
         SELECT person_id, name, count(*)::int AS n
         FROM stamped
         WHERE name IS NOT NULL
         GROUP BY person_id, name
       )
       SELECT person_id, name FROM counted ORDER BY n DESC, name ASC`,
      [inventoryId, costCenterId],
    )) as Array<{ person_id: string | null; name: string }>;
    return rows.map((row) => ({ personId: row.person_id, name: row.name }));
  }

  async mostFrequentForCenter(
    inventoryId: string,
    costCenterId: string,
  ): Promise<{ personId: string | null; name: string | null }> {
    const list = await this.companionsForCenter(inventoryId, costCenterId);
    const first = list[0];
    return first ? { personId: first.personId, name: first.name } : { personId: null, name: null };
  }

  private resolveWho(dto: SetLocationCompanionDto): { personId: string | null; name: string | null } {
    const personId = dto.personId ?? null;
    const name = dto.name?.trim() || null;
    if ((personId && name) || (!personId && !name)) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Elija una persona o escriba un nombre, no ambos.', [
        { field: name ? 'name' : 'personId', message: 'Elija una persona o escriba un nombre, no ambos.' },
      ]);
    }
    return { personId, name };
  }

  private async personName(personId: string | null): Promise<string | null> {
    if (!personId) {
      return null;
    }
    const [row] = (await this.dataSource.query(
      `SELECT trim(first_name || ' ' || last_name) AS name FROM person WHERE id = $1`,
      [personId],
    )) as Array<{ name: string }>;
    return row?.name ?? null;
  }

  private async requireInventory(id: string): Promise<PhysicalInventory> {
    const inventory = await this.inventories.findOne({ where: { id } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return inventory;
  }

  private toDto(inventoryId: string, locationId: string, row: InventoryLocationCompanion | null) {
    if (!row) {
      return { inventoryId, locationId, companion: null };
    }
    return {
      inventoryId,
      locationId,
      companion: {
        personId: row.personId,
        name: row.name ?? '',
        recordedAt: row.recordedAt.toISOString(),
        recordedBy: row.recordedBy,
      },
    };
  }
}
