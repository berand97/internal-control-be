import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

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
