import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AssetCategory } from '../../categories/entities/asset-category.entity.js';
import { AssetCategoryField } from '../entities/asset-category-field.entity.js';
import type {
  CreateDynamicFieldRecord,
  DynamicFieldsRepository,
  UpdateDynamicFieldRecord,
} from './dynamic-fields.repository.interface.js';

@Injectable()
export class TypeOrmDynamicFieldsRepository implements DynamicFieldsRepository {
  constructor(
    @InjectRepository(AssetCategoryField)
    private readonly fields: Repository<AssetCategoryField>,
    @InjectRepository(AssetCategory)
    private readonly categories: Repository<AssetCategory>,
    private readonly dataSource: DataSource,
  ) {}

  findByCategory(
    categoryId: string,
  ): Promise<ReadonlyArray<AssetCategoryField>> {
    return this.fields.find({
      where: { categoryId },
      order: { orderIndex: 'ASC', label: 'ASC' },
    });
  }

  findById(id: string): Promise<AssetCategoryField | null> {
    return this.fields.findOne({ where: { id } });
  }

  findCategoryById(id: string): Promise<AssetCategory | null> {
    return this.categories.findOne({ where: { id } });
  }

  insert(record: CreateDynamicFieldRecord): Promise<AssetCategoryField> {
    const entity = this.fields.create(record);
    return this.fields.save(entity);
  }

  async update(id: string, record: UpdateDynamicFieldRecord): Promise<void> {
    await this.fields.update({ id }, record);
  }

  async remove(id: string): Promise<void> {
    await this.fields.delete({ id });
  }

  async deprecate(id: string): Promise<void> {
    await this.fields.update({ id }, { isActive: false });
  }

  async countValues(fieldId: string): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM asset_custom_value WHERE field_id = $1`,
      [fieldId],
    );
    if (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') {
      const row = rows[0] as { count?: number };
      return typeof row.count === 'number' ? row.count : 0;
    }
    return 0;
  }
}
