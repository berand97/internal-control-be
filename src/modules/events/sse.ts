/**
 * Formato text/event-stream (https://html.spec.whatwg.org/multipage/server-sent-events.html). `data` va en una sola
 * línea: JSON.stringify no produce saltos de línea.
 */
export const formatSseEvent = (event: string, data: unknown, id?: string): string =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Comentario de latido: el navegador lo ignora, pero mantiene viva la conexión en proxies y detecta clientes caídos. */
export const SSE_PING = ': ping\n\n';

/** Cabeceras del stream: sin caché ni transformación (compresión) y sin buffering en Nginx/Traefik. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
  Connection: 'keep-alive',
};

/** Id de evento: event_seq de notification (BIGINT >= 0) en decimal. */
const EVENT_ID_PATTERN = /^\d{1,18}$/;

/**
 * Cursor de reposición: cabecera Last-Event-ID (reconexión nativa de EventSource) o, si no viene, `lastEventId` de la
 * query (reconexión con un ticket nuevo). Un valor que no sea un id nuestro se ignora: el stream arranca sin reponer.
 */
export const resolveLastEventId = (header: unknown, query: unknown): string | null => {
  for (const candidate of [header, query]) {
    if (typeof candidate === 'string' && EVENT_ID_PATTERN.test(candidate.trim())) {
      return BigInt(candidate.trim()).toString();
    }
  }
  return null;
};
