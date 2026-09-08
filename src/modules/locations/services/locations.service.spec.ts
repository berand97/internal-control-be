import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Building } from '../../buildings/entities/building.entity.js';
import { Campus } from '../../campus/entities/campus.entity.js';
import { Location } from '../entities/location.entity.js';
import { LocationType } from '../enums/location-type.enum.js';
import type { LocationsRepository } from '../repositories/locations.repository.interface.js';
import { LocationsService } from './locations.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const building = (): Building => {
  const item = new Building();
  item.id = 'building-1';
  item.campusId = 'campus-1';
  item.name = 'Bloque A';
  item.isActive = true;
  return item;
};

const campus = (): Campus => {
  const item = new Campus();
  item.id = 'campus-1';
  item.name = 'Campus Medellín';
  return item;
};

const location = (): Location => {
  const item = new Location();
  item.id = 'loc-1';
  item.buildingId = 'building-1';
  item.code = 'A-205';
  item.name = 'Oficina 205';
  item.floorNumber = 2;
  item.locationType = LocationType.Office;
  item.capacity = null;
  item.isActive = true;
  return item;
};

describe('LocationsService', () => {
  let locationsRepository: LocationsRepository;
  let service: LocationsService;

  beforeEach(() => {
    locationsRepository = {
      findByBuilding: vi.fn(),
      findById: vi.fn(),
      findByIdWithPath: vi.fn(),
      findBuildingById: vi.fn().mockResolvedValue(building()),
      search: vi.fn().mockResolvedValue([
        { location: location(), building: building(), campus: campus() },
      ]),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new LocationsService(locationsRepository, auditLogsRepository);
  });

  it('busca con campus, edificio y tipo', async () => {
    const result = await service.search({
      campusId: 'campus-1',
      buildingId: 'building-1',
      type: LocationType.Office,
      q: '205',
    });
    expect(locationsRepository.search).toHaveBeenCalledWith({
      campusId: 'campus-1',
      buildingId: 'building-1',
      type: LocationType.Office,
      q: '205',
    });
    expect(result[0]?.fullPath).toBe(
      'Campus Medellín / Bloque A / Piso 2 / Oficina 205',
    );
  });

  it('no crea ubicación en edificio inexistente', async () => {
    vi.mocked(locationsRepository.findBuildingById).mockResolvedValue(null);
    await expect(
      service.create(
        'missing',
        { code: 'X', name: 'X', type: LocationType.Office },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
  });
});
