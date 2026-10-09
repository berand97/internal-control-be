import { describe, expect, it } from 'vitest';
import { resolveFeaturesConfig } from './features-config.js';

describe('Configuración de módulos (FEATURE_*)', () => {
  it('sin variables usa los valores por defecto', () => {
    expect(resolveFeaturesConfig({})).toEqual({
      circuitThreshold: 5,
      circuitWindowMs: 120_000,
      circuitCooldownMs: 300_000,
      reloadIntervalMs: 30_000,
      overrides: {},
    });
  });

  it('los ajustes FEATURE_* reservados no se leen como kill-switch de un módulo', () => {
    const config = resolveFeaturesConfig({
      FEATURE_CIRCUIT_THRESHOLD: '3',
      FEATURE_CIRCUIT_WINDOW_SECONDS: '60',
      FEATURE_CIRCUIT_COOLDOWN_SECONDS: '600',
      FEATURE_FLAGS_RELOAD_SECONDS: '0',
      FEATURE_QR_TOKENS: 'false',
      FEATURE_LOANS: 'true',
    });
    expect(config).toMatchObject({
      circuitThreshold: 3,
      circuitWindowMs: 60_000,
      circuitCooldownMs: 600_000,
      reloadIntervalMs: 0,
    });
    expect(config.overrides).toEqual({ 'qr-tokens': false, loans: true });
  });

  it('un valor fuera de rango detiene el arranque', () => {
    expect(() => resolveFeaturesConfig({ FEATURE_FLAGS_RELOAD_SECONDS: '-1' })).toThrow(/FEATURE_FLAGS_RELOAD_SECONDS/);
    expect(() => resolveFeaturesConfig({ FEATURE_FLAGS_RELOAD_SECONDS: '3601' })).toThrow(/FEATURE_FLAGS_RELOAD_SECONDS/);
    expect(() => resolveFeaturesConfig({ FEATURE_CIRCUIT_THRESHOLD: '0' })).toThrow(/FEATURE_CIRCUIT_THRESHOLD/);
    expect(() => resolveFeaturesConfig({ FEATURE_CIRCUIT_WINDOW_SECONDS: '0' })).toThrow(/FEATURE_CIRCUIT_WINDOW_SECONDS/);
    expect(() => resolveFeaturesConfig({ FEATURE_CIRCUIT_COOLDOWN_SECONDS: 'x' })).toThrow(
      /FEATURE_CIRCUIT_COOLDOWN_SECONDS/,
    );
  });
});
