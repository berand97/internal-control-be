import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { ASSET_REQUEST_REVIEW } from '../../asset-requests/domain/asset-request.js';
import { CONTROL_SIGNER_PERMISSION } from '../domain/signer-separation.js';
import type { ControlSignerDto } from '../dto/document.responses.js';
import { DocumentFormatCatalogService } from './document-format-catalog.service.js';

/**
 * Quién tiene hoy un permiso de firma: usuario ACTIVE, persona activa, con el permiso vigente
 * (v_user_effective_permissions: asignaciones sin revocar, dentro de su vigencia, con herencia de roles).
 * Única fuente de la lista: la usan los firmantes del traslado (TransferSignersService, Control Interno y
 * Contabilidad) y la lista neutral de firmantes de Control Interno (GET /documents/control-signers).
 */
@Injectable()
export class ControlSignersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
    private readonly catalog: DocumentFormatCatalogService,
  ) {}

  async holders(permission: string, manager: EntityManager = this.dataSource.manager): Promise<ControlSignerDto[]> {
    const rows = await manager.query(
      `SELECT DISTINCT p.id AS "personId", trim(p.first_name || ' ' || p.last_name) AS name
       FROM v_user_effective_permissions v
       JOIN app_user u ON u.id = v.user_id AND u.status = 'ACTIVE'
       JOIN person p ON p.id = u.person_id AND p.is_active
       WHERE v.permission_code = $1
       ORDER BY name, "personId"`,
      [permission],
    );
    return rows as ControlSignerDto[];
  }

  /**
   * Personas que pueden firmar por Control Interno, para quien genera un acta: cualquier permiso de generación de
   * un formato vigente del catálogo (asset:update:global, loan:update:global, inventory:execute:global, …) o
   * asset_request:review:global. Sin ninguno: 403 INSUFFICIENT_PERMISSIONS.
   */
  async forGenerator(actorId: string): Promise<ControlSignerDto[]> {
    const formats = await this.catalog.currentAll();
    const allowed = [...new Set([...formats.map((format) => format.generatePermission), ASSET_REQUEST_REVIEW])];
    for (const permission of allowed) {
      if (await this.permissions.userHasPermission(actorId, permission)) {
        return this.holders(CONTROL_SIGNER_PERMISSION);
      }
    }
    throw new ApiException(
      ErrorCode.InsufficientPermissions,
      'Ver quién firma por Control Interno requiere un permiso de generación de actas o asset_request:review:global',
    );
  }
}
