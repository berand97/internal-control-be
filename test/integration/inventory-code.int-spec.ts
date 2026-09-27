import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { InventoryScopeType } from '../../src/modules/inventories/enums/inventory-scope.js';
import { InventoriesModule } from '../../src/modules/inventories/inventories.module.js';
import { InventorySchedulesService } from '../../src/modules/inventories/services/inventory-schedules.service.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Código de toma física (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let inventories: InventorySchedulesService;
  let actor: AuthenticatedUser;

  beforeAll(async () => {
    // InventoriesModule encola el acta OCI-21-37: el motor de actas necesita el almacenamiento.
    moduleRef = await bootModules(InventoriesModule, StorageModule);
    dataSource = moduleRef.get(DataSource);
    inventories = moduleRef.get(InventorySchedulesService);
    actor = await createActor(dataSource);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('dos tomas consecutivas reciben códigos distintos y correlativos', async () => {
    const create = async (code: string) => {
      const costCenterId = await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro de toma') RETURNING id`,
        [code],
      );
      const created = (await inventories.schedule(
        {
          name: `Toma ${code}`,
          scope: InventoryScopeType.CostCenter,
          scopeId: costCenterId,
          plannedStartDate: '2026-10-01',
          plannedEndDate: '2026-10-31',
          responsibleUserId: actor.id,
        },
        actor,
      )) as { id: string };
      return scalar<string>(dataSource, 'SELECT code FROM physical_inventory WHERE id = $1', [created.id]);
    };

    const first = await create('TF-CODE-1');
    const second = await create('TF-CODE-2');
    const year = new Date().getFullYear();
    expect(first).toMatch(new RegExp(`^TF-${year}-\\d{3,}$`));
    expect(second).not.toBe(first);
    expect(Number(second.split('-').pop())).toBe(Number(first.split('-').pop()) + 1);
    expect(first).not.toBe(`TF-${year}-000`);
  });
});
