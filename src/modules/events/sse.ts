export const formatSseEvent = (event: string, data: unknown, id?: string): string =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const SSE_PING = formatSseEvent('ping', {});

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
  Connection: 'keep-alive',
};

const EVENT_ID_PATTERN = /^\d{1,18}$/;

export const resolveLastEventId = (header: unknown, query: unknown): string | null => {
  for (const candidate of [header, query]) {
    if (typeof candidate === 'string' && EVENT_ID_PATTERN.test(candidate.trim())) {
      return BigInt(candidate.trim()).toString();
    }
  }
  return null;
};
