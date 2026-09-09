import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NavigationItemEntity } from '../entities/navigation-item.entity.js';
import type {
  CreateNavigationRecord,
  NavigationRepository,
  UpdateNavigationRecord,
} from './navigation.repository.interface.js';

@Injectable()
export class TypeOrmNavigationRepository implements NavigationRepository {
  constructor(
    @InjectRepository(NavigationItemEntity)
    private readonly items: Repository<NavigationItemEntity>,
  ) {}

  findAll(): Promise<ReadonlyArray<NavigationItemEntity>> {
    return this.items.find({ order: { sortOrder: 'ASC', label: 'ASC' } });
  }

  findActive(): Promise<ReadonlyArray<NavigationItemEntity>> {
    return this.items.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', label: 'ASC' },
    });
  }

  findById(id: string): Promise<NavigationItemEntity | null> {
    return this.items.findOne({ where: { id } });
  }

  insert(record: CreateNavigationRecord): Promise<NavigationItemEntity> {
    const now = new Date();
    return this.items.save(
      this.items.create({
        ...record,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async update(id: string, record: UpdateNavigationRecord): Promise<void> {
    await this.items.update({ id }, { ...record, updatedAt: new Date() });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.items.delete({ id });
    return (result.affected ?? 0) > 0;
  }
}
