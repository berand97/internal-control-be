/**
 * Canal de eventos en tiempo real (GET /api/v1/events, SSE). Se valida al arrancar: un valor fuera de rango detiene el
 * backend con el motivo.
 */
export interface EventsConfig {
  /** Streams abiertos a la vez en esta instancia (EVENTS_MAX_STREAMS). El siguiente recibe 503 EVENTS_CAPACITY_REACHED. */
  readonly maxStreams: number;
  /** Cada cuánto se manda el evento de latido `ping` y se revalida la sesión (EVENTS_HEARTBEAT_MS). */
  readonly heartbeatMs: number;
  /** Vida del ticket de un solo uso de POST /events/ticket (EVENTS_TICKET_TTL_SECONDS, máximo 30). */
  readonly ticketTtlSeconds: number;
}

export const DEFAULT_EVENTS_MAX_STREAMS = 500;
export const DEFAULT_EVENTS_HEARTBEAT_MS = 25_000;
export const DEFAULT_EVENTS_TICKET_TTL_SECONDS = 30;

const readIntegerInRange = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} debe ser un entero entre ${min} y ${max} (recibido: ${raw})`);
  }
  return parsed;
};

export const resolveEventsConfig = (env: Readonly<Record<string, string | undefined>>): EventsConfig => ({
  maxStreams: readIntegerInRange(env, 'EVENTS_MAX_STREAMS', DEFAULT_EVENTS_MAX_STREAMS, 1, 100_000),
  // Por debajo del timeout de inactividad de cualquier proxy razonable (Traefik, Nginx: 60 s o más).
  heartbeatMs: readIntegerInRange(env, 'EVENTS_HEARTBEAT_MS', DEFAULT_EVENTS_HEARTBEAT_MS, 100, 55_000),
  ticketTtlSeconds: readIntegerInRange(env, 'EVENTS_TICKET_TTL_SECONDS', DEFAULT_EVENTS_TICKET_TTL_SECONDS, 1, 30),
});
