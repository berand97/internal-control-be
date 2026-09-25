import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Código interno de activo (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: AssetsService;
  let actor: AuthenticatedUser;
  let base: {
    categoryId: string;
    costCenterId: string;
    acquisitionTypeId: string;
  };

  const counter = (): Promise<string> =>
    scalar<string>(
      dataSource,
      `SELECT current_value FROM code_sequence WHERE sequence_name = 'asset_internal_code'`,
    );

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule);
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(AssetsService);
    actor = await createActor(dataSource);
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo)
       VALUES ('IT_SEQ', 'Categoría de prueba', FALSE) RETURNING id`,
    );
    base = {
      categoryId,
      costCenterId: await scalar<string>(
        dataSource,
        `SELECT id FROM cost_center WHERE external_code = '4100'`,
      ),
      acquisitionTypeId: await scalar<string>(
        dataSource,
        `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
      ),
    };
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const newAsset = (extra: Record<string, unknown> = {}) =>
    service.create(
      {
        description: `Activo ${randomUUID().slice(0, 6)}`,
        categoryId: base.categoryId,
        costCenterId: base.costCenterId,
        acquisitionTypeId: base.acquisitionTypeId,
        acquisitionDate: '2024-05-10',
        ...extra,
      },
      actor,
    );

  it('asigna tres códigos distintos y consecutivos seguidos', async () => {
    const created = [await newAsset(), await newAsset(), await newAsset()];
    const codes = created.map((asset) => asset.internalCode);
    expect(new Set(codes).size).toBe(3);
    const numbers = codes.map((code) => Number(code.split('-').at(-1)));
    expect(numbers[1]).toBe((numbers[0] ?? 0) + 1);
    expect(numbers[2]).toBe((numbers[0] ?? 0) + 2);
    expect(codes[0]).toMatch(/^A2024-\d{4}$/);
  });

  it('no consume el contador cuando la operación hace rollback', async () => {
    const before = await counter();
    const assetsBefore = await scalar<string>(dataSource, 'SELECT count(*) FROM asset');
    const movementsBefore = await scalar<string>(
      dataSource,
      'SELECT count(*) FROM asset_movement',
    );

    // responsibleId no existe: el INSERT del activo viola la FK después de
    // haber reservado el código, dentro de la misma transacción.
    await expect(newAsset({ responsibleId: randomUUID() })).rejects.toThrow();

    expect(await counter()).toBe(before);
    expect(await scalar<string>(dataSource, 'SELECT count(*) FROM asset')).toBe(assetsBefore);
    expect(
      await scalar<string>(dataSource, 'SELECT count(*) FROM asset_movement'),
    ).toBe(movementsBefore);
  });
});
