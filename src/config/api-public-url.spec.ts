import { describe, expect, it } from 'vitest';
import { apiPublicUrlWarning } from './api-public-url.js';

describe('API_PUBLIC_URL (imágenes de los correos)', () => {
  it('fuera de producción no advierte', () => {
    expect(apiPublicUrlWarning({ NODE_ENV: 'development' })).toBeNull();
    expect(apiPublicUrlWarning({})).toBeNull();
  });

  it('en producción advierte si falta, si no es https o si no es pública', () => {
    expect(apiPublicUrlWarning({ NODE_ENV: 'production' })).toMatch(/no está configurada/);
    expect(apiPublicUrlWarning({ NODE_ENV: 'production', API_PUBLIC_URL: 'http://api.unac.edu.co' })).toMatch(/https/);
    expect(apiPublicUrlWarning({ NODE_ENV: 'production', API_PUBLIC_URL: 'https://192.168.1.10' })).toMatch(/pública/);
    expect(apiPublicUrlWarning({ NODE_ENV: 'production', API_PUBLIC_URL: 'https://api.control-interno.unac.edu.co' })).toBeNull();
  });
});
