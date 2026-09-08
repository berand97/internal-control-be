import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AssetCategory } from '../entities/asset-category.entity.js';
import type {
  CategoriesRepository,
  CategorySearchFilters,
  CreateCategoryRecord,
  UpdateCategoryRecord,
} from './categories.repository.interface.js';

@Injectable()
export class TypeOrmCategoriesRepository implements CategoriesRepository {
  constructor(
    @InjectRepository(AssetCategory)
    private readonly categories: Repository<AssetCategory>,
    private readonly dataSource: DataSource,
  ) {}

  findAll(
    filters: CategorySearchFilters,
  ): Promise<ReadonlyArray<AssetCategory>> {
    const qb = this.categories
      .createQueryBuilder('category')
      .orderBy('category.name', 'ASC');
    if (filters.q) {
      qb.andWhere('(category.name ILIKE :q OR category.code ILIKE :q)', {
        q: `%${filters.q}%`,
      });
    }
    if (filters.parentId === null) {
      qb.andWhere('category.parent_id IS NULL');
    } else if (filters.parentId) {
      qb.andWhere('category.parent_id = :parentId', {
        parentId: filters.parentId,
      });
    }
    if (filters.isActive !== undefined) {
      qb.andWhere('category.is_active = :isActive', {
        isActive: filters.isActive,
      });
    }
    return qb.getMany();
  }

  findById(id: string): Promise<AssetCategory | null> {
    return this.categories.findOne({ where: { id } });
  }

  insert(record: CreateCategoryRecord): Promise<AssetCategory> {
    const entity = this.categories.create({
      ...record,
      createdAt: new Date(),
    });
    return this.categories.save(entity);
  }

  async update(id: string, record: UpdateCategoryRecord): Promise<void> {
    await this.categories.update({ id }, record);
  }

  async deactivate(id: string): Promise<void> {
    await this.categories.update({ id }, { isActive: false });
  }

  countActiveChildren(parentId: string): Promise<number> {
    return this.categories.count({ where: { parentId, isActive: true } });
  }

  async countAssets(categoryId: string): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM asset WHERE category_id = $1`,
      [categoryId],
    );
    if (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') {
      const row = rows[0] as { count?: number };
      return typeof row.count === 'number' ? row.count : 0;
    }
    return 0;
  }

  async rewriteDescendantPaths(oldPath: string, newPath: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE asset_category
      SET hierarchy_path = $1 || substr(hierarchy_path, $2)
      WHERE hierarchy_path LIKE $3
      `,
      [newPath, oldPath.length + 1, `${oldPath}/%`],
    );
  }
}
