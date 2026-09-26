// Un activo retenido por un préstamo abierto no se edita, no se da de baja ni cambia de centro. La definición de
// "retenido" es la de la solicitud de préstamo (LoansService.create): OPEN_LOAN_STATUSES y el ítem sin received_at.
// Los activos se dejan IN_USE a propósito: el estado ON_LOAN es otra defensa (assertMutable) y aquí se prueba que la
// del préstamo se sostiene sola.
import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../src/common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import type { LoanStatus } from '../../src/modules/loans/enums/loan-status.js';
import { GLOBAL_COST_CENTER_SCOPE } from '../../src/modules/roles/services/cost-center-scope.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Guardas del activo frente a préstamos abiertos (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let assets: AssetsService;
  let actor: AuthenticatedUser;
  let base: { categoryId: string; costCenterId: string; acquisitionTypeId: string };
  let targetCenter: string;

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule);
    dataSource = moduleRef.get(DataSource);
    assets = moduleRef.get(AssetsService);
    actor = await createActor(dataSource);
    const tag = randomUUID().slice(0, 6).toUpperCase();
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Categoría guardas', FALSE) RETURNING id`,
        [`IT_LG_${tag}`],
      ),
      costCenterId: await scalar<string>(
        dataSource,
        `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro origen guardas') RETURNING id`,
        [`IT-LG-A-${tag}`],
      ),
      acquisitionTypeId: await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`),
    };
    targetCenter = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro destino guardas') RETURNING id`,
      [`IT-LG-B-${tag}`],
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const newAsset = async () =>
    (
      await assets.create(
        { ...base, description: `Activo guardas ${randomUUID().slice(0, 6)}`, acquisitionDate: '2022-03-01' },
        actor,
      )
    ).id;

  /** Préstamo en ese estado con sus ítems; received marca el ítem como ya recibido de vuelta. */
  const loan = async (status: LoanStatus, items: ReadonlyArray<{ assetId: string; received?: boolean }>) => {
    const delivered = status !== 'REQUESTED';
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO asset_loan (source_cost_center_id, target_cost_center_id, expected_return_date, requested_by, status,
         purpose, delivered_at)
       VALUES ($1, $2, CURRENT_DATE + 30, $3, $4::loan_status, 'Guardas', CASE WHEN $5 THEN NOW() - interval '2 days' END)
       RETURNING id`,
      [base.costCenterId, targetCenter, actor.id, status, delivered],
    );
    for (const item of items) {
      await dataSource.query(
        `INSERT INTO asset_loan_item (loan_id, asset_id, source_cost_center_id, received_at, returned_at, return_condition)
         VALUES ($1, $2, $3, CASE WHEN $4 THEN NOW() END, CASE WHEN $4 THEN NOW() END, CASE WHEN $4 THEN 'GOOD' END)`,
        [id, item.assetId, base.costCenterId, item.received === true],
      );
    }
    return id;
  };

  const blocked = { code: ErrorCode.AssetHasActiveLoan };
  const edit = (assetId: string) => assets.update(assetId, { notes: `Nota ${randomUUID().slice(0, 6)}` }, actor);
  const writeOff = (assetId: string) =>
    assets.writeOff(assetId, { reason: 'Baja de prueba', documentReference: 'ACTA-IT-001' }, actor);
  const moveCenter = (assetId: string) =>
    assets.reassignCostCenter(assetId, targetCenter, 'OFICIO-IT-001', 'Cambio de prueba', actor);

  const expectBlocked = async (assetId: string) => {
    await expect(edit(assetId)).rejects.toMatchObject(blocked);
    await expect(writeOff(assetId)).rejects.toMatchObject(blocked);
    await expect(moveCenter(assetId)).rejects.toMatchObject(blocked);
    expect(
      await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId]),
    ).not.toBe('WRITTEN_OFF');
    expect(await scalar<string>(dataSource, 'SELECT current_cost_center_id FROM asset WHERE id = $1', [assetId])).toBe(
      base.costCenterId,
    );
  };

  const expectAllowed = async (assetId: string) => {
    await expect(edit(assetId)).resolves.toMatchObject({ id: assetId });
    await expect(moveCenter(assetId)).resolves.toMatchObject({ id: assetId });
    await expect(writeOff(assetId)).resolves.toMatchObject({ id: assetId, operationalStatus: 'WRITTEN_OFF' });
  };

  it('préstamo PENDING_SIGNATURES (entregado, acta sin todas las firmas): editar, dar de baja y cambiar de centro se rechazan', async () => {
    const assetId = await newAsset();
    const loanId = await loan('PENDING_SIGNATURES', [{ assetId }]);
    await expectBlocked(assetId);
    expect((await assets.getById(assetId, GLOBAL_COST_CENTER_SCOPE)).activeLoans).toEqual([{ id: loanId, status: 'PENDING_SIGNATURES' }]);
  });

  it('préstamo PARTIALLY_RETURNED: el activo que sigue fuera está bloqueado; el ya recibido queda libre', async () => {
    const outstanding = await newAsset();
    const received = await newAsset();
    const loanId = await loan('PARTIALLY_RETURNED', [{ assetId: outstanding }, { assetId: received, received: true }]);

    await expectBlocked(outstanding);
    expect((await assets.getById(outstanding, GLOBAL_COST_CENTER_SCOPE)).activeLoans).toEqual([{ id: loanId, status: 'PARTIALLY_RETURNED' }]);

    expect((await assets.getById(received, GLOBAL_COST_CENTER_SCOPE)).activeLoans).toEqual([]);
    await expectAllowed(received);
  });

  it('misma definición que la solicitud de préstamo: una solicitud REQUESTED también retiene el activo', async () => {
    const assetId = await newAsset();
    await loan('REQUESTED', [{ assetId }]);
    await expectBlocked(assetId);
  });

  it('préstamos cerrados (RETURNED, CLOSED_WITH_LOSSES, CANCELLED, REJECTED) no retienen el activo', async () => {
    for (const status of ['RETURNED', 'CLOSED_WITH_LOSSES', 'CANCELLED', 'REJECTED'] as const) {
      const assetId = await newAsset();
      await loan(status, [{ assetId, received: status === 'RETURNED' || status === 'CLOSED_WITH_LOSSES' }]);
      expect((await assets.getById(assetId, GLOBAL_COST_CENTER_SCOPE)).activeLoans, status).toEqual([]);
      await expectAllowed(assetId);
    }
  });
});
