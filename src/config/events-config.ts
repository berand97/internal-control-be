
export interface EventsConfig {
  readonly maxStreams: number;
  readonly heartbeatMs: number;
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
  heartbeatMs: readIntegerInRange(env, 'EVENTS_HEARTBEAT_MS', DEFAULT_EVENTS_HEARTBEAT_MS, 100, 55_000),
  ticketTtlSeconds: readIntegerInRange(env, 'EVENTS_TICKET_TTL_SECONDS', DEFAULT_EVENTS_TICKET_TTL_SECONDS, 1, 30),
});
