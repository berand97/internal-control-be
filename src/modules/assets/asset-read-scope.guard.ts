import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { AuthenticatedRequest } from '../../common/types/authenticated-request.type.js';
import {
  type ReadableCostCenterScope,
  requireReadableScope,
} from '../roles/services/cost-center-scope.js';
import { PermissionsService } from '../roles/services/permissions.service.js';

export const ASSET_READ_GLOBAL = 'asset:read:global';
export const ASSET_READ_SCOPED = 'asset:read:org_unit';

const CATALOG_KEY = 'assetReadCatalog';

/**
 * Marca un endpoint de catálogo (sin datos de activos): basta con tener
 * cualquiera de los dos permisos de lectura, aunque no alcance ningún centro.
 */
export const AssetReadCatalog = (): MethodDecorator =>
  SetMetadata(CATALOG_KEY, true);

type ScopedRequest = AuthenticatedRequest & {
  assetReadScope?: ReadableCostCenterScope;
};

/**
 * Lectura de activos: acepta asset:read:global (sin filtro) o
 * asset:read:org_unit (solo los centros de costo de las asignaciones
 * COST_CENTER vigentes del usuario). Deja el alcance resuelto en el request
 * para que el handler lo reciba con @AssetReadScope().
 */
@Injectable()
export class AssetReadScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const user = request.user;
    if (!user) {
      throw new ApiException(ErrorCode.Unauthorized);
    }
    const scope = await this.permissions.costCenterScope(
      user.id,
      ASSET_READ_GLOBAL,
      ASSET_READ_SCOPED,
    );
    const catalog = this.reflector.get<boolean | undefined>(
      CATALOG_KEY,
      context.getHandler(),
    );
    if (catalog && scope.kind === 'EMPTY') {
      return true;
    }
    request.assetReadScope = requireReadableScope(
      scope,
      ASSET_READ_GLOBAL,
      ASSET_READ_SCOPED,
    );
    return true;
  }
}

export const AssetReadScope = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ReadableCostCenterScope => {
    const scope = ctx.switchToHttp().getRequest<ScopedRequest>().assetReadScope;
    if (!scope) {
      // Sin guard no hay alcance: nunca caer en "ver todo" por omisión.
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    return scope;
  },
);
