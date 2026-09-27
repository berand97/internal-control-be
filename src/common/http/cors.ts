import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

/**
 * Cabeceras de respuesta que el frontend (otro origen) necesita leer. Sin Access-Control-Expose-Headers el navegador
 * solo expone las "CORS-safelisted" y oculta estas dos:
 * - Retry-After: segundos de espera del 429 ACCOUNT_TEMPORARILY_LOCKED (bloqueo por cuenta).
 * - Content-Disposition: nombre de archivo de las descargas (plantillas, actas).
 */
export const CORS_EXPOSED_HEADERS = [
  'Retry-After',
  'Content-Disposition',
] as const;

export const buildCorsOptions = (
  allowedOrigins: Iterable<string>,
): CorsOptions => ({
  origin: Array.from(allowedOrigins),
  credentials: true,
  exposedHeaders: [...CORS_EXPOSED_HEADERS],
});
