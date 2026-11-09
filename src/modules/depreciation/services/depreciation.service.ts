import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Asset } from '../../assets/entities/asset.entity.js';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import {
  calculatePeriodDepreciation,
  type DepreciationAssetInput,
} from '../domain/calculate-depreciation.js';
import {
  CalculateDepreciationDto,
  QueryDepreciationDto,
} from '../dto/depreciation.dto.js';
import { AssetDepreciation } from '../entities/asset-depreciation.entity.js';

const periodEntityId = (year: number, month: number): string =>
  `${String(year)}-${String(month).padStart(2, '0')}`;

@Injectable()
export class DepreciationService {
  constructor(
    @InjectRepository(AssetDepreciation)
    private readonly snapshots: Repository<AssetDepreciation>,
    @InjectRepository(Asset)
    private readonly assets: Repository<Asset>,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async calculate(dto: CalculateDepreciationDto, actor: AuthenticatedUser | null) {
    this.assertPeriod(dto.year, dto.month);
    if (await this.isPeriodClosed(dto.year, dto.month)) {
      throw new ApiException(ErrorCode.DepreciationPeriodClosed);
    }
    const assets = await this.assets.find();
    const dated = assets.filter(
      (asset): asset is typeof asset & { acquisitionDate: string } =>
        asset.acquisitionDate !== null,
    );
    const inputs: DepreciationAssetInput[] = dated.map((asset) => ({
      id: asset.id,
      acquisitionDate: asset.acquisitionDate,
      acquisitionPrice: Number(asset.acquisitionPrice),
      salvageValue: Number(asset.salvageValue),
      usefulLifeYears: asset.usefulLifeYears,
      method: asset.depreciationMethod,
      operationalStatus: asset.operationalStatus,
      writtenOffAt: asset.writtenOffAt,
      costCenterId: asset.costCenterId,
      categoryId: asset.categoryId,
    }));
    const result = calculatePeriodDepreciation(inputs, dto.year, dto.month);
    const now = new Date();
    await this.snapshots.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AssetDepreciation);
      await repo.delete({ periodYear: dto.year, periodMonth: dto.month });
      if (result.snapshots.length === 0) {
        return;
      }
      const rows = result.snapshots.map((snapshot) =>
        repo.create({
          assetId: snapshot.assetId,
          periodYear: dto.year,
          periodMonth: dto.month,
          method: snapshot.method,
          monthlyDepreciation: snapshot.monthlyDepreciation,
          accumulatedDepreciation: snapshot.accumulatedDepreciation,
          bookValue: snapshot.bookValue,
          isClosed: false,
          calculatedAt: now,
          calculatedBy: actor?.id ?? null,
        }),
      );
      for (let index = 0; index < rows.length; index += 500) {
        await repo.save(rows.slice(index, index + 500));
      }
    });
    await this.auditLogsRepository.record({
      action: AuditAction.DepreciationCalculated,
      entityType: 'DEPRECIATION',
      entityId: periodEntityId(dto.year, dto.month),
      performedBy: actor?.id ?? null,
      ipAddress: null,
      userAgent: null,
      changes: {
        year: dto.year,
        month: dto.month,
        calculated: result.snapshots.length,
        excluded: result.excluded.length,
      },
    });
    return {
      year: dto.year,
      month: dto.month,
      calculated: result.snapshots.length,
      excluded: result.excluded,
      isClosed: false,
    };
  }

  async close(dto: CalculateDepreciationDto, actor: AuthenticatedUser) {
    this.assertPeriod(dto.year, dto.month);
    const count = await this.snapshots.count({
      where: { periodYear: dto.year, periodMonth: dto.month },
    });
    if (count === 0) {
      throw new ApiException(ErrorCode.DepreciationPeriodEmpty);
    }
    if (await this.isPeriodClosed(dto.year, dto.month)) {
      throw new ApiException(ErrorCode.DepreciationPeriodClosed);
    }
    await this.snapshots.update(
      { periodYear: dto.year, periodMonth: dto.month },
      { isClosed: true },
    );
    await this.auditLogsRepository.record({
      action: AuditAction.DepreciationClosed,
      entityType: 'DEPRECIATION',
      entityId: periodEntityId(dto.year, dto.month),
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { year: dto.year, month: dto.month, rows: count },
    });
    return { year: dto.year, month: dto.month, isClosed: true, rows: count };
  }

  async reopen(dto: CalculateDepreciationDto, actor: AuthenticatedUser) {
    this.assertPeriod(dto.year, dto.month);
    const count = await this.snapshots.count({
      where: { periodYear: dto.year, periodMonth: dto.month },
    });
    if (count === 0) {
      throw new ApiException(ErrorCode.DepreciationPeriodEmpty);
    }
    if (!(await this.isPeriodClosed(dto.year, dto.month))) {
      throw new ApiException(ErrorCode.DepreciationPeriodOpen);
    }
    await this.snapshots.update(
      { periodYear: dto.year, periodMonth: dto.month },
      { isClosed: false },
    );
    await this.auditLogsRepository.record({
      action: AuditAction.DepreciationReopened,
      entityType: 'DEPRECIATION',
      entityId: periodEntityId(dto.year, dto.month),
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { year: dto.year, month: dto.month, rows: count },
    });
    return { year: dto.year, month: dto.month, isClosed: false, rows: count };
  }

  async list(query: QueryDepreciationDto) {
    const page = Number(query.page) || 1;
    const pageSize = Math.min(Number(query.pageSize) || 20, 100);
    const qb = this.snapshots
      .createQueryBuilder('d')
      .innerJoin(Asset, 'a', 'a.id = d.asset_id');
    if (query.year !== undefined) {
      qb.andWhere('d.period_year = :year', { year: query.year });
    }
    if (query.month !== undefined) {
      qb.andWhere('d.period_month = :month', { month: query.month });
    }
    if (query.costCenterId) {
      qb.andWhere('a.current_cost_center_id = :costCenterId', {
        costCenterId: query.costCenterId,
      });
    }
    if (query.categoryId) {
      qb.andWhere('a.category_id = :categoryId', { categoryId: query.categoryId });
    }
    const total = await qb.clone().getCount();
    const items = await qb
      .addSelect('a.internal_code')
      .orderBy('d.period_year', 'DESC')
      .addOrderBy('d.period_month', 'DESC')
      .addOrderBy('a.internal_code', 'ASC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getMany();
    return {
      items: items.map((item) => this.toRow(item)),
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
    };
  }

  async summary(year: number, month: number) {
    this.assertPeriod(year, month);
    const isClosed = await this.isPeriodClosed(year, month);
    const rows: unknown = await this.snapshots.manager.query(
      `
      SELECT
        a.current_cost_center_id AS "costCenterId",
        a.category_id AS "categoryId",
        COUNT(*)::int AS assets,
        SUM(d.monthly_depreciation)::numeric(15,2) AS "monthlyDepreciation",
        SUM(d.accumulated_depreciation)::numeric(15,2) AS "accumulatedDepreciation",
        SUM(d.book_value)::numeric(15,2) AS "bookValue"
      FROM asset_depreciation d
      JOIN asset a ON a.id = d.asset_id
      WHERE d.period_year = $1 AND d.period_month = $2
      GROUP BY a.current_cost_center_id, a.category_id
      ORDER BY a.current_cost_center_id, a.category_id
      `,
      [year, month],
    );
    return {
      year,
      month,
      isClosed,
      groups: Array.isArray(rows) ? rows : [],
    };
  }

  async history(assetId: string) {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const items = await this.snapshots.find({
      where: { assetId },
      order: { periodYear: 'ASC', periodMonth: 'ASC' },
    });
    return {
      assetId,
      method: asset.depreciationMethod ?? DepreciationMethod.StraightLine,
      items: items.map((item) => this.toRow(item)),
    };
  }

  async calculatePreviousMonth(): Promise<void> {
    const now = new Date();
    const month = now.getMonth() === 0 ? 12 : now.getMonth();
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    await this.calculate({ year, month }, null);
  }

  private async isPeriodClosed(year: number, month: number): Promise<boolean> {
    return this.snapshots.exists({
      where: { periodYear: year, periodMonth: month, isClosed: true },
    });
  }

  private assertPeriod(year: number, month: number): void {
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new ApiException(ErrorCode.DepreciationInvalidPeriod);
    }
  }

  private toRow(item: AssetDepreciation) {
    return {
      id: item.id,
      assetId: item.assetId,
      year: item.periodYear,
      month: item.periodMonth,
      method: item.method,
      monthlyDepreciation: item.monthlyDepreciation,
      accumulatedDepreciation: item.accumulatedDepreciation,
      bookValue: item.bookValue,
      isClosed: item.isClosed,
      calculatedAt: item.calculatedAt,
      calculatedBy: item.calculatedBy,
    };
  }
}
