import { afterEach, describe, expect, it } from 'vitest';
import configuration from './configuration.js';
import { resolveGotenbergUrl } from './gotenberg-url.js';

describe('GOTENBERG_URL', () => {
  it('es opcional fuera de producción', () => {
    expect(resolveGotenbergUrl({ NODE_ENV: 'development' })).toBeNull();
    expect(resolveGotenbergUrl({})).toBeNull();
    expect(resolveGotenbergUrl({ GOTENBERG_URL: '  ' })).toBeNull();
  });

  it('es obligatoria en producción', () => {
    expect(() => resolveGotenbergUrl({ NODE_ENV: 'production' })).toThrow(/GOTENBERG_URL es obligatoria en producción/);
    expect(() => resolveGotenbergUrl({ NODE_ENV: 'production', GOTENBERG_URL: '' })).toThrow(/obligatoria/);
  });

  it('valida la forma y quita la barra final', () => {
    expect(resolveGotenbergUrl({ NODE_ENV: 'production', GOTENBERG_URL: 'http://gotenberg:3000/' })).toBe('http://gotenberg:3000');
    expect(resolveGotenbergUrl({ GOTENBERG_URL: 'http://localhost:3100' })).toBe('http://localhost:3100');
    expect(() => resolveGotenbergUrl({ GOTENBERG_URL: 'gotenberg' })).toThrow(/no es una URL válida/);
    expect(() => resolveGotenbergUrl({ GOTENBERG_URL: 'ftp://gotenberg:3000' })).toThrow(/http o https/);
    expect(() => resolveGotenbergUrl({ GOTENBERG_URL: 'http://u:p@gotenberg:3000' })).toThrow(/credenciales/);
  });
});

describe('configuration() en producción', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const production = (extra: Record<string, string>): void => {
    process.env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@control-interno-database:5432/db',
      JWT_ACCESS_SECRET: 'a',
      JWT_REFRESH_SECRET: 'b',
      ...extra,
    };
  };

  it('no arranca sin SIGNATURE_VERIFY_URL (primero) ni sin GOTENBERG_URL', () => {
    production({});
    expect(() => configuration()).toThrow(/SIGNATURE_VERIFY_URL es obligatoria/);
    production({ SIGNATURE_VERIFY_URL: 'https://control-interno.unac.edu.co/verificar-firma' });
    expect(() => configuration()).toThrow(/GOTENBERG_URL es obligatoria/);
  });

  it('arranca con ambas y acepta la BD desplegada', () => {
    production({
      SIGNATURE_VERIFY_URL: 'https://control-interno.unac.edu.co/verificar-firma',
      GOTENBERG_URL: 'http://gotenberg:3000',
    });
    const config = configuration();
    expect(config.documents.gotenbergUrl).toBe('http://gotenberg:3000');
    expect(config.database.url).toContain('control-interno-database');
  });

  it('fuera de producción rechaza la BD desplegada', () => {
    production({});
    process.env['NODE_ENV'] = 'development';
    expect(() => configuration()).toThrow(/host no local \(control-interno-database\)/);
  });
});
