import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../constants/error-code.enum.js';
import { FEATURE_CODE_KEY } from '../decorators/feature.decorator.js';
import { ApiException } from '../exceptions/api.exception.js';
import { featureCodesForPath } from '../../modules/features/feature-catalog.js';
import { FeatureFlagsService } from '../../modules/features/services/feature-flags.service.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.type.js';

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const decorated = this.reflector.getAllAndOverride<string | undefined>(
      FEATURE_CODE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const codes = new Set<string>(featureCodesForPath(request.path ?? ''));
    if (decorated) {
      codes.add(decorated);
    }

    for (const code of codes) {
      if (!this.featureFlags.isEnabled(code)) {
        throw new ApiException(ErrorCode.ModuleUnavailable);
      }
    }
    return true;
  }
}
