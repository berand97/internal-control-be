import { describe, expect, it } from 'vitest';
import { parseAppEvent, serializeAppEvent } from './app-event.js';

const USER = '0b6f5a4e-9d4a-4c1e-8f7e-2a1b3c4d5e6f';
const REF = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('AppEvent (payload de NOTIFY)', () => {
  it('ida y vuelta: solo ids y tipo', () => {
    const payload = serializeAppEvent({ userId: USER, type: 'notification', refId: REF });
    expect(JSON.parse(payload)).toEqual({ userId: USER, type: 'notification', refId: REF });
    expect(parseAppEvent(payload)).toEqual({ userId: USER, type: 'notification', refId: REF });
    expect(parseAppEvent(serializeAppEvent({ userId: USER, type: 'notification.count', refId: null }))).toEqual({
      userId: USER,
      type: 'notification.count',
      refId: null,
    });
  });

  it('no publica ids que no sean UUID', () => {
    expect(() => serializeAppEvent({ userId: 'juan', type: 'notification', refId: null })).toThrow(/UUID/);
    expect(() => serializeAppEvent({ userId: USER, type: 'notification', refId: 'x' })).toThrow(/UUID/);
  });

  it('descarta payloads inválidos sin lanzar', () => {
    expect(parseAppEvent(undefined)).toBeNull();
    expect(parseAppEvent('no-json')).toBeNull();
    expect(parseAppEvent('null')).toBeNull();
    expect(parseAppEvent(JSON.stringify({ userId: USER, type: 'otro', refId: null }))).toBeNull();
    expect(parseAppEvent(JSON.stringify({ userId: 'x', type: 'notification', refId: null }))).toBeNull();
    expect(parseAppEvent(JSON.stringify({ userId: USER, type: 'notification', refId: 5 }))).toBeNull();
  });
});
