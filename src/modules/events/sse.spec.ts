import { describe, expect, it } from 'vitest';
import { formatSseEvent, resolveLastEventId } from './sse.js';

describe('Formato SSE', () => {
  it('evento con y sin id, data en una línea', () => {
    expect(formatSseEvent('notification', { title: 'a\nb' }, '42')).toBe(
      'id: 42\nevent: notification\ndata: {"title":"a\\nb"}\n\n',
    );
    expect(formatSseEvent('notification.count', { unread: 3 })).toBe(
      'event: notification.count\ndata: {"unread":3}\n\n',
    );
  });
});

describe('Last-Event-ID', () => {
  it('la cabecera manda sobre la query', () => {
    expect(resolveLastEventId('17', '5')).toBe('17');
    expect(resolveLastEventId(undefined, '5')).toBe('5');
    expect(resolveLastEventId(' 007 ', undefined)).toBe('7');
  });

  it('un valor que no es un id nuestro se ignora', () => {
    expect(resolveLastEventId('abc', undefined)).toBeNull();
    expect(resolveLastEventId('abc', '9')).toBe('9');
    expect(resolveLastEventId('-1', 'x')).toBeNull();
    expect(resolveLastEventId('1'.repeat(19), undefined)).toBeNull();
    expect(resolveLastEventId(undefined, undefined)).toBeNull();
  });
});
