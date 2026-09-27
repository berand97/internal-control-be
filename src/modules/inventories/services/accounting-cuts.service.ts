import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { CreateAccountingCutDto, SetInventoryAccountingCutDto } from '../dto/inventory-reconciliation.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { InventoryValuationService } from './inventory-valuation.service.js';

const CUT_COLUMNS = `
  c.id, to_char(c.cut_date, 'YYYY-MM-DD') AS "cutDate", c.source_label AS "sourceLabel", c.source_kind AS "sourceKind",
  c.staging_import_id AS "stagingImportId", c.notes, c.created_by AS "createdBy", c.created_at AS "createdAt",
  (SELECT count(*)::int FROM accounting_cut_line l WHERE l.cut_id = c.id) AS "lineCount",
  (SELECT count(*)::int FROM physical_inventory i WHERE i.accounting_cut_id = c.id) AS "inventoryCount"`;

/** Tomas a las que aún se les puede cambiar el corte: antes de cerrar. */
const CUT_EDITABLE_STATUSES: ReadonlyArray<InventoryStatus> = [InventoryStatus.Planned, InventoryStatus.InProgress];

/**
 * Cortes contables (fecha y fuente) y su asociación a una toma. Las líneas del corte (valor en libros por activo)
 * entran por el importador cuando Contabilidad defina las columnas de su reporte; mientras tanto un corte MANUAL
 * fija la fecha de valoración y la fuente que la pantalla muestra.
 */
@Injectable()
export class AccountingCutsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly valuation: InventoryValuationService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async list() {
    return this.dataSource.query(`SELECT ${CUT_COLUMNS} FROM accounting_cut c ORDER BY c.cut_date DESC, c.created_at DESC`);
  }

  async get(id: string) {
    const [row] = (await this.dataSource.query(`SELECT ${CUT_COLUMNS} FROM accounting_cut c WHERE c.id = $1`, [
      id,
    ])) as unknown[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return row;
  }

  async create(dto: CreateAccountingCutDto, actor: AuthenticatedUser) {
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = (await manager.query(
        `INSERT INTO accounting_cut (cut_date, source_label, source_kind, notes, created_by)
         VALUES ($1, $2, 'MANUAL', $3, $4) RETURNING id`,
        [dto.cutDate, dto.sourceLabel, dto.notes?.trim() || null, actor.id],
      )) as Array<{ id: string }>;
      await this.auditLogs.record(
        {
          action: AuditAction.AccountingCutCreated,
          entityType: 'ACCOUNTING_CUT',
          entityId: row?.id ?? '',
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { cutDate: dto.cutDate, sourceKind: 'MANUAL' },
        },
        manager,
      );
      return row?.id ?? '';
    });
    return this.get(id);
  }

  /** Asocia o desasocia el corte de una toma PLANNED o IN_PROGRESS; devuelve la base de conciliación resultante. */
  async setForInventory(inventoryId: string, dto: SetInventoryAccountingCutDto, actor: AuthenticatedUser) {
    const cutId = dto.accountingCutId ?? null;
    const inventory = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(PhysicalInventory);
      const found = await repository.findOne({ where: { id: inventoryId }, lock: { mode: 'pessimistic_write' } });
      if (!found) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (!CUT_EDITABLE_STATUSES.includes(found.status)) {
        throw new ApiException(
          ErrorCode.InvalidState,
          'El corte contable se asocia o cambia antes de cerrar la toma',
        );
      }
      if (cutId) {
        const [cut] = (await manager.query('SELECT id FROM accounting_cut WHERE id = $1', [cutId])) as unknown[];
        if (!cut) {
          throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el corte contable');
        }
      }
      const previous = found.accountingCutId ?? null;
      found.accountingCutId = cutId;
      await repository.save(found);
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryCutLinked,
          entityType: 'INVENTORY',
          entityId: found.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { accountingCutId: { from: previous, to: cutId } },
        },
        manager,
      );
      return found;
    });
    return {
      inventoryId: inventory.id,
      accountingCutId: inventory.accountingCutId,
      reconciliationBasis: await this.valuation.basis(inventory),
    };
  }
}
