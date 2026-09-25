import type { TestingModule } from '@nestjs/testing';
import { DataSource, type EntityManager } from 'typeorm';
import { DocumentTemplatesModule } from '../../src/modules/document-templates/document-templates.module.js';
import { DocumentTemplatesService } from '../../src/modules/document-templates/services/document-templates.service.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { bootModules, scalar } from './helpers.js';

type WithActNumber = {
  nextActNumber(manager?: EntityManager): Promise<string>;
};

describe('Número de acta (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: WithActNumber;

  const counter = (): Promise<string> =>
    scalar<string>(
      dataSource,
      `SELECT current_value FROM code_sequence WHERE sequence_name = 'document_act'`,
    );

  beforeAll(async () => {
    moduleRef = await bootModules(StorageModule, DocumentTemplatesModule);
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(DocumentTemplatesService) as unknown as WithActNumber;
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('entrega números distintos y consecutivos', async () => {
    const first = await service.nextActNumber();
    const second = await service.nextActNumber();
    const year = new Date().getFullYear();
    expect(first).toMatch(new RegExp(`^ACT-${year}-\\d{4}$`));
    expect(Number(second.split('-').at(-1))).toBe(
      Number(first.split('-').at(-1)) + 1,
    );
  });

  it('no consume el número si la transacción hace rollback', async () => {
    const before = await counter();
    await expect(
      dataSource.transaction(async (manager) => {
        await service.nextActNumber(manager);
        throw new Error('fallo después de reservar');
      }),
    ).rejects.toThrow('fallo después de reservar');
    expect(await counter()).toBe(before);
  });
});
