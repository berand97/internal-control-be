import { describe, expect, it } from 'vitest';
import { resolveEventsConfig } from './events-config.js';

describe('Configuración del canal de eventos (EVENTS_*)', () => {
  it('sin variables usa los valores por defecto', () => {
    expect(resolveEventsConfig({})).toEqual({ maxStreams: 500, heartbeatMs: 25_000, ticketTtlSeconds: 30 });
    expect(resolveEventsConfig({ EVENTS_MAX_STREAMS: ' ' })).toMatchObject({ maxStreams: 500 });
  });

  it('acepta enteros dentro del rango', () => {
    expect(
      resolveEventsConfig({ EVENTS_MAX_STREAMS: '20', EVENTS_HEARTBEAT_MS: '200', EVENTS_TICKET_TTL_SECONDS: '5' }),
    ).toEqual({ maxStreams: 20, heartbeatMs: 200, ticketTtlSeconds: 5 });
  });

  it('un valor fuera de rango o no entero detiene el arranque', () => {
    expect(() => resolveEventsConfig({ EVENTS_MAX_STREAMS: '0' })).toThrow(/EVENTS_MAX_STREAMS debe ser un entero/);
    expect(() => resolveEventsConfig({ EVENTS_MAX_STREAMS: 'mil' })).toThrow(/EVENTS_MAX_STREAMS/);
    expect(() => resolveEventsConfig({ EVENTS_MAX_STREAMS: '2.5' })).toThrow(/EVENTS_MAX_STREAMS/);
    expect(() => resolveEventsConfig({ EVENTS_HEARTBEAT_MS: '60000' })).toThrow(/EVENTS_HEARTBEAT_MS/);
    expect(() => resolveEventsConfig({ EVENTS_TICKET_TTL_SECONDS: '31' })).toThrow(/EVENTS_TICKET_TTL_SECONDS/);
    expect(() => resolveEventsConfig({ EVENTS_TICKET_TTL_SECONDS: '-1' })).toThrow(/EVENTS_TICKET_TTL_SECONDS/);
  });
});
