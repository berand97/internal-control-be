/**
 * Evento de la aplicación que viaja por el EventBus (hoy PostgreSQL LISTEN/NOTIFY). Solo lleva ids: quien lo recibe
 * lee el detalle de la BD con las reglas de visibilidad del usuario. Nunca contenido (títulos, cuerpos, datos
 * personales) en el payload: NOTIFY lo ve cualquier sesión que escuche el canal y su límite es 8 KB.
 */
export const APP_EVENT_TYPES = [
  /** Se creó una notificación para userId (refId = notification.id). */
  'notification',
  /** Cambió el conteo de no leídas de userId (marcar leída o todas). refId = null. */
  'notification.count',
] as const;

export type AppEventType = (typeof APP_EVENT_TYPES)[number];

export interface AppEvent {
  readonly userId: string;
  readonly type: AppEventType;
  readonly refId: string | null;
}

/** Canal de NOTIFY/LISTEN. */
export const APP_EVENTS_CHANNEL = 'app_events';

/** Límite de NOTIFY en PostgreSQL (8000 bytes por defecto); el payload real mide ~120 bytes. */
export const MAX_EVENT_PAYLOAD_BYTES = 8000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isAppEventType = (value: unknown): value is AppEventType =>
  typeof value === 'string' && (APP_EVENT_TYPES as ReadonlyArray<string>).includes(value);

export const serializeAppEvent = (event: AppEvent): string => {
  if (!UUID_PATTERN.test(event.userId) || (event.refId !== null && !UUID_PATTERN.test(event.refId))) {
    throw new Error('AppEvent: userId y refId deben ser UUID');
  }
  const payload = JSON.stringify({ userId: event.userId, type: event.type, refId: event.refId });
  if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error('AppEvent: el payload supera el límite de NOTIFY');
  }
  return payload;
};

/** null si el payload no es un AppEvent válido (se descarta sin romper la conexión LISTEN). */
export const parseAppEvent = (payload: string | undefined): AppEvent | null => {
  if (!payload) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { userId, type, refId } = raw as Record<string, unknown>;
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId) || !isAppEventType(type)) {
    return null;
  }
  if (refId !== null && (typeof refId !== 'string' || !UUID_PATTERN.test(refId))) {
    return null;
  }
  return { userId, type, refId };
};
