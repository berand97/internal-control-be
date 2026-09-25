import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { GLOBAL_COST_CENTER_SCOPE } from '../../src/modules/roles/services/cost-center-scope.js';
import { DepreciationModule } from '../../src/modules/depreciation/depreciation.module.js';
import { MonthlyDepreciationJob } from '../../src/modules/depreciation/jobs/monthly-depreciation.job.js';
import { DepreciationService } from '../../src/modules/depreciation/services/depreciation.service.js';
import { FeatureFlagsService } from '../../src/modules/features/services/feature-flags.service.js';
import { bootModules, createActor, scalar } from './helpers.js';

describe('Depreciación apagada y activos sin fecha (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let actor: AuthenticatedUser;

  beforeAll(async () => {
    moduleRef = await bootModules(AssetsModule, DepreciationModule);
    dataSource = moduleRef.get(DataSource);
    actor = await createActor(dataSource);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('depreciación arranca apagada sin que nadie la configure', () => {
    const flags = moduleRef.get(FeatureFlagsService);
    expect(flags.isEnabled('depreciation')).toBe(false);
    expect(flags.list().find((feature) => feature.code === 'depreciation')).toMatchObject({
      enabled: false,
      reason: 'DEFAULT',
    });
    expect(flags.isEnabled('assets')).toBe(true);
  });

  it('el cron mensual no calcula mientras esté apagada', async () => {
    const service = moduleRef.get(DepreciationService);
    const spy = vi.spyOn(service, 'calculatePreviousMonth');
    await moduleRef.get(MonthlyDepreciationJob).runMonthly();
    expect(spy).not.toHaveBeenCalled();
    expect(Number(await scalar<string>(dataSource, 'SELECT count(*) FROM asset_depreciation'))).toBe(0);
  });

  it('un activo cargado sin fecha se lee con acquisitionDate null', async () => {
    await dataSource.query(
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('IT_DEPR', 'Depreciación', FALSE)`,
    );
    await dataSource.query(
      `INSERT INTO cost_center (external_code, name) VALUES ('IT-DEPR', 'Centro depreciación')`,
    );
    const assetId = await scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id,
         acquisition_date, current_cost_center_id, created_by, data_quality_flags)
       VALUES ('IT-SINFECHA', 'Sin fecha',
         (SELECT id FROM asset_category WHERE code = 'IT_DEPR'),
         (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'),
         NULL, (SELECT id FROM cost_center WHERE external_code = 'IT-DEPR'), $1,
         ARRAY['ACQUISITION_DATE_MISSING'])
       RETURNING id`,
      [actor.id],
    );
    const asset = await moduleRef.get(AssetsService).getById(assetId, GLOBAL_COST_CENTER_SCOPE);
    expect(asset.acquisitionDate).toBeNull();
  });
});
