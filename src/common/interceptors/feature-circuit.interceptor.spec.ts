import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureCircuitInterceptor } from './feature-circuit.interceptor.js';

describe('FeatureCircuitInterceptor', () => {
  const featureFlags = {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    releaseProbe: vi.fn(),
  };
  const reflector = { getAllAndOverride: vi.fn() };
  let interceptor: FeatureCircuitInterceptor;

  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ path: '/api/v1/loans' }) }),
  } as never;

  beforeEach(() => {
    featureFlags.recordSuccess.mockReset().mockResolvedValue(undefined);
    featureFlags.recordFailure.mockReset().mockResolvedValue(undefined);
    featureFlags.releaseProbe.mockReset();
    reflector.getAllAndOverride.mockReset().mockReturnValue(undefined);
    interceptor = new FeatureCircuitInterceptor(reflector as never, featureFlags as never);
  });

  it('una respuesta correcta cuenta como éxito (cierra el circuito si era la prueba)', async () => {
    await lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') }));
    expect(featureFlags.recordSuccess).toHaveBeenCalledWith('loans');
  });

  it('un error interno cuenta como fallo', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => new InternalServerErrorException()) })),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(featureFlags.recordFailure).toHaveBeenCalledWith('loans');
    expect(featureFlags.releaseProbe).not.toHaveBeenCalled();
  });

  it('un 4xx no cuenta: solo libera el turno de prueba', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => new BadRequestException()) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(featureFlags.recordFailure).not.toHaveBeenCalled();
    expect(featureFlags.recordSuccess).not.toHaveBeenCalled();
    expect(featureFlags.releaseProbe).toHaveBeenCalledWith('loans');
  });
});
