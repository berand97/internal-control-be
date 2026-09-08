import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from '../../modules/roles/services/permissions.service.js';
import type { PermissionScope } from '../../modules/roles/types/effective-permission.type.js';
import { ErrorCode } from '../constants/error-code.enum.js';
import {
  REQUIRE_PERMISSION_KEY,
  type PermissionRequirement,
} from '../decorators/require-permission.decorator.js';
import { ApiException } from '../exceptions/api.exception.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.type.js';
import type { TokenScopeType } from '../types/authenticated-user.type.js';

const readStringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const firstPresent = (
  ...values: ReadonlyArray<string | undefined>
): string | undefined => values.find((value) => value !== undefined);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      PermissionRequirement | undefined
    >(REQUIRE_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ApiException(ErrorCode.Unauthorized);
    }

    if (required.code.endsWith(':own')) {
      const ownerId = this.readOwnerId(request);
      if (ownerId !== undefined && ownerId !== user.id) {
        throw new ApiException(ErrorCode.OutOfScope);
      }
    }

    const scope = this.extractScope(required, request);
    const allowed = await this.permissionsService.userHasPermission(
      user.id,
      required.code,
      scope,
    );
    if (!allowed) {
      throw new ApiException(
        ErrorCode.InsufficientPermissions,
        `Requiere permiso ${required.code}`,
      );
    }
    return true;
  }

  private extractScope(
    requirement: PermissionRequirement,
    request: AuthenticatedRequest,
  ): PermissionScope | undefined {
    if (requirement.scopeFrom && requirement.scopeType) {
      const scopeId = requirement.scopeFrom(request);
      if (!scopeId) {
        return undefined;
      }
      return { type: requirement.scopeType, id: scopeId };
    }

    const inferredType = inferScopeTypeFromCode(requirement.code);
    if (!inferredType || inferredType === 'GLOBAL') {
      return undefined;
    }
    const scopeId = this.readScopeId(request, inferredType);
    if (!scopeId) {
      return undefined;
    }
    return { type: inferredType, id: scopeId };
  }

  private readScopeId(
    request: AuthenticatedRequest,
    type: TokenScopeType,
  ): string | undefined {
    const params = request.params ?? {};
    const body: unknown = request.body;
    const bodyRecord =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};

    if (type === 'ORG_UNIT') {
      return firstPresent(
        readStringField(params['orgUnitId']),
        readStringField(params['organizationalUnitId']),
        readStringField(bodyRecord['orgUnitId']),
        readStringField(bodyRecord['organizationalUnitId']),
      );
    }
    if (type === 'COST_CENTER') {
      return firstPresent(
        readStringField(params['costCenterId']),
        readStringField(bodyRecord['costCenterId']),
      );
    }
    return undefined;
  }

  private readOwnerId(request: AuthenticatedRequest): string | undefined {
    const params = request.params ?? {};
    const body: unknown = request.body;
    const bodyRecord =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    return firstPresent(
      readStringField(params['userId']),
      readStringField(bodyRecord['createdBy']),
      readStringField(bodyRecord['requestedBy']),
    );
  }
}

const inferScopeTypeFromCode = (
  code: string,
): TokenScopeType | undefined => {
  if (code.endsWith(':org_unit')) {
    return 'ORG_UNIT';
  }
  if (code.endsWith(':cost_center')) {
    return 'COST_CENTER';
  }
  if (code.endsWith(':global')) {
    return 'GLOBAL';
  }
  return undefined;
};
