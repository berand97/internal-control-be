export const APP_EVENT_TYPES = [
  'notification',
  'notification.count',
] as const;

export type AppEventType = (typeof APP_EVENT_TYPES)[number];

export interface AppEvent {
  readonly userId: string;
  readonly type: AppEventType;
  readonly refId: string | null;
}

export const APP_EVENTS_CHANNEL = 'app_events';

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
