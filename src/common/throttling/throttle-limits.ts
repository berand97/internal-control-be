/**
 * Límite general del ThrottlerModule (app.module.ts): peticiones por ruta en una ventana de 60 s.
 * - Sin sesión: por IP (req.ip, que respeta TRUST_PROXY), como siempre.
 * - Con access token válido: por usuario (claim sub, el mismo usuario de la sesión), con su propio cupo. Detrás del NAT
 *   de la universidad todos los empleados comparten IP: contar por IP haría que la campana de notificaciones de unos
 *   pocos dejara al resto con 429.
 * Los límites estrictos declarados con @Throttle (login, MFA, recuperación de contraseña, enlaces de firma,
 * verificación pública del acta y del QR) no cambian: siguen por IP con su límite.
 */
export const THROTTLE_TTL_MS = 60_000;
export const THROTTLE_IP_LIMIT = 100;
export const DEFAULT_THROTTLE_USER_LIMIT = 300;
