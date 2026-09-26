import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type { PersonDirectoryItemDto, PersonDirectoryResponseDto } from '../dto/person-directory.dto.js';

/**
 * Quién puede consultar el directorio: quien genera o administra actas (elige quién recibe, quién firma por
 * Control Interno y a quién reasignar un turno). Son los permisos de generación de los formatos que hoy tienen
 * proceso (OCI-01-55 y OCI-17-89: asset:update:global; OCI-01-65: loan:update:global). No es un permiso nuevo.
 */
export const PERSON_DIRECTORY_PERMISSIONS = ['asset:update:global', 'loan:update:global'] as const;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

@Injectable()
export class PersonDirectoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
  ) {}

  async assertCanRead(actorId: string): Promise<void> {
    for (const permission of PERSON_DIRECTORY_PERMISSIONS) {
      if (await this.permissions.userHasPermission(actorId, permission)) {
        return;
      }
    }
    throw new ApiException(
      ErrorCode.InsufficientPermissions,
      `Requiere alguno de los permisos ${PERSON_DIRECTORY_PERMISSIONS.join(', ')}`,
    );
  }

  /**
   * Personas activas. La búsqueda por nombre usa la misma expresión que el índice trigram idx_person_name
   * (first_name || ' ' || last_name); la de documento es por prefijo.
   */
  async search(query: { readonly search?: string; readonly page: number; readonly pageSize: number }): Promise<PersonDirectoryResponseDto> {
    const term = query.search?.trim() ? query.search.trim() : null;
    const params = [term === null ? null : `%${escapeLike(term)}%`, term === null ? null : `${escapeLike(term)}%`];
    const where = `p.is_active
      AND ($1::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $1 OR p.document_number LIKE $2)`;
    const [count] = (await this.dataSource.query(`SELECT count(*)::int AS total FROM person p WHERE ${where}`, params)) as Array<{
      total: number;
    }>;
    const items = (await this.dataSource.query(
      `SELECT p.id, trim(p.first_name || ' ' || p.last_name) AS name, p.document_type AS "documentType", p.document_number AS "documentNumber",
              p.position_title AS "positionTitle", p.email,
              (u.id IS NOT NULL) AS "hasActiveUser", coalesce(u.mfa_enabled, FALSE) AS "mfaEnabled"
       FROM person p
       LEFT JOIN app_user u ON u.person_id = p.id AND u.status = 'ACTIVE'
       WHERE ${where}
       ORDER BY p.first_name, p.last_name, p.id
       LIMIT $3 OFFSET $4`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as PersonDirectoryItemDto[];
    const total = count?.total ?? 0;
    return { items, page: query.page, pageSize: query.pageSize, total, hasNext: query.page * query.pageSize < total };
  }
}
