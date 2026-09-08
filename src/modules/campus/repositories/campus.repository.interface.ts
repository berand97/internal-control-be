import type { Campus } from '../entities/campus.entity.js';

export interface CreateCampusRecord {
  readonly code: string;
  readonly name: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly department: string | null;
  readonly country: string | null;
  readonly isActive: boolean;
}

export interface UpdateCampusRecord {
  readonly code?: string;
  readonly name?: string;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly department?: string | null;
  readonly country?: string | null;
  readonly isActive?: boolean;
}

export interface CampusRepository {
  findAll(isActive?: boolean): Promise<ReadonlyArray<Campus>>;
  findById(id: string): Promise<Campus | null>;
  insert(record: CreateCampusRecord): Promise<Campus>;
  update(id: string, record: UpdateCampusRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
  countBuildings(campusId: string): Promise<number>;
}
