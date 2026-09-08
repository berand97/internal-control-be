import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../constants/error-code.enum.js';
import { FEATURE_CODE_KEY } from '../decorators/feature.decorator.js';
import { FeatureGuard } from './feature.guard.js';

describe('FeatureGuard', () => {
  const featureFlags = { isEnabled: vi.fn() };
  const reflector = { getAllAndOverride: vi.fn() };
  let guard: FeatureGuard;

  beforeEach(() => {
    featureFlags.isEnabled.mockReset().mockReturnValue(true);
    reflector.getAllAndOverride.mockReset();
    guard = new FeatureGuard(reflector as never, featureFlags as never);
  });

  const contextFor = (path: string): never =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ path }),
      }),
    }) as never;

  it('deja pasar si el módulo está activo', () => {
    reflector.getAllAndOverride.mockReturnValue('loans');
    expect(guard.canActivate(contextFor('/api/v1/loans'))).toBe(true);
  });

  it('bloquea con MODULE_UNAVAILABLE si el módulo está apagado', () => {
    reflector.getAllAndOverride.mockReturnValue('loans');
    featureFlags.isEnabled.mockImplementation((code: string) => code !== 'loans');
    try {
      guard.canActivate(contextFor('/api/v1/loans'));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.ModuleUnavailable });
    }
  });

  it('usa el prefijo de ruta cuando no hay decorator', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    featureFlags.isEnabled.mockImplementation((code: string) => code !== 'loans');
    try {
      guard.canActivate(contextFor('/api/v1/loans/1'));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.ModuleUnavailable });
    }
  });

  it('consulta el metadata del decorator', () => {
    reflector.getAllAndOverride.mockReturnValue('qr-tokens');
    guard.canActivate(contextFor('/api/v1/assets/1/qr'));
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(FEATURE_CODE_KEY, [
      expect.anything(),
      expect.anything(),
    ]);
    expect(featureFlags.isEnabled).toHaveBeenCalledWith('qr-tokens');
    expect(featureFlags.isEnabled).toHaveBeenCalledWith('assets');
  });
});
