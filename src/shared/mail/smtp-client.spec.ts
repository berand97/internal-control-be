import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidMailbox, NO_CONTROL_CHARS, UnsafeMailFieldError } from './mail-address.js';
import { extractSmtpAddress, prepareSmtpMessage, sendSmtpMail } from './smtp-client.js';

const base = {
  host: '127.0.0.1',
  port: 0,
  secure: false,
  from: 'Control Interno UNAC <noreply@unac.edu.co>',
  to: 'ana.ruiz@unac.edu.co',
  subject: 'Asunto',
  text: 'Cuerpo',
};

// Caso del hallazgo BE-06: destinatario externo, salto de línea y sufijo institucional.
const INJECTED_TO = 'a@x.com>\nRCPT TO:<b@unac.edu.co';

describe('extractSmtpAddress', () => {
  it('toma el correo entre ángulos', () => {
    expect(extractSmtpAddress('Control Interno UNAC <noreply@unac.edu.co>')).toBe(
      'noreply@unac.edu.co',
    );
  });

  it('deja el valor si ya es un correo', () => {
    expect(extractSmtpAddress('noreply@unac.edu.co')).toBe('noreply@unac.edu.co');
  });
});

describe('isValidMailbox', () => {
  it.each(['ana.ruiz@unac.edu.co', 'j_perez+firma@unac.edu.co', 'a@b.co'])('acepta %s', (value) => {
    expect(isValidMailbox(value)).toBe(true);
  });

  it.each([
    INJECTED_TO,
    'a@x.com\r\nRCPT TO:<b@unac.edu.co>',
    'ana@unac.edu.co\u0000',
    'ana ruiz@unac.edu.co',
    '<ana@unac.edu.co>',
    'ana@unac',
    '.ana@unac.edu.co',
    'ana..ruiz@unac.edu.co',
    '',
  ])('rechaza %j', (value) => {
    expect(isValidMailbox(value)).toBe(false);
  });
});

describe('prepareSmtpMessage', () => {
  const rejects = (options: typeof base, field: string): void => {
    try {
      prepareSmtpMessage(options);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeMailFieldError);
      expect((error as UnsafeMailFieldError).field).toBe(field);
      expect((error as Error).message).not.toContain('@');
      return;
    }
    throw new Error('se esperaba UnsafeMailFieldError');
  };

  it('rechaza el destinatario del hallazgo sin repetirlo en el error', () => {
    rejects({ ...base, to: INJECTED_TO }, 'to');
  });

  it('rechaza un fromName con CR/LF (cabecera inyectada)', () => {
    rejects({ ...base, from: 'Control\r\nBcc: x@evil.com <noreply@unac.edu.co>' }, 'fromName');
  });

  it('rechaza un remitente con salto de línea', () => {
    rejects({ ...base, from: 'noreply@unac.edu.co\nBcc: x@evil.com' }, 'from');
    // Con ángulos, lo anterior al salto queda como nombre visible: también se rechaza.
    rejects({ ...base, from: 'noreply@unac.edu.co\nRCPT TO:<x@evil.com>' }, 'fromName');
  });

  it('codifica nombre y asunto (RFC 2047) y deja las direcciones solas', () => {
    const message = prepareSmtpMessage({ ...base, subject: 'Firma\r\nBcc: x@evil.com' });
    expect(message.mailFrom).toBe('MAIL FROM:<noreply@unac.edu.co>');
    expect(message.rcptTo).toBe('RCPT TO:<ana.ruiz@unac.edu.co>');
    const headers = message.payload.split('\r\n\r\n')[0]?.split('\r\n') ?? [];
    expect(headers.map((line) => line.replace(/^(Date|Message-ID): .*/, '$1: *'))).toEqual([
      `From: =?UTF-8?B?${Buffer.from('Control Interno UNAC').toString('base64')}?= <noreply@unac.edu.co>`,
      'To: ana.ruiz@unac.edu.co',
      `Subject: =?UTF-8?B?${Buffer.from('Firma\r\nBcc: x@evil.com').toString('base64')}?=`,
      'Date: *',
      'Message-ID: *',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(headers.find((line) => line.startsWith('Message-ID:'))).toMatch(/^Message-ID: <[0-9a-f-]{36}@unac\.edu\.co>$/);
  });

  it('un asunto largo se parte en palabras codificadas plegadas, sin cortar caracteres', () => {
    const subject = `Firma pendiente: ${'Acta de entrega y asignación de activos fijos · '.repeat(4)}`;
    const message = prepareSmtpMessage({ ...base, subject });
    const head = message.payload.split('\r\n\r\n')[0] ?? '';
    const subjectLines = head.slice(head.indexOf('Subject: ')).split('\r\n').filter((line, index) => index === 0 || line.startsWith(' '));
    expect(subjectLines.length).toBeGreaterThan(1);
    for (const line of subjectLines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    const decoded = subjectLines
      .map((line) => /=\?UTF-8\?B\?([^?]*)\?=/.exec(line)?.[1] ?? '')
      .map((word) => Buffer.from(word, 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
  });

  it('el cuerpo va en base64 en líneas de 76: un "." o un LF suelto no pueden cerrar el DATA', () => {
    const text = `hola\n.\nMAIL FROM:<x@evil.com>\r.\r\nfin ${'x'.repeat(3000)}`;
    const message = prepareSmtpMessage({ ...base, text });
    expect(message.payload.endsWith('\r\n.')).toBe(true);
    expect(message.payload.slice(0, -1)).not.toMatch(/(^|\r\n)\.(\r\n|$)/);
    expect(message.payload).not.toContain('MAIL FROM:<x@evil.com>');
    const body = message.payload.split('\r\n\r\n')[1]?.replace(/\r\n\.$/, '') ?? '';
    for (const line of body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
      expect(line.startsWith('.')).toBe(false);
    }
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      text.replace(/\r\n|\r|\n/g, '\r\n'),
    );
  });

  it('con html arma multipart/alternative: texto y HTML en base64 con un límite propio', () => {
    const html = '<!DOCTYPE html><html><body><p>Hola &amp; adiós</p></body></html>';
    const message = prepareSmtpMessage({ ...base, text: 'Hola & adiós', html }, '=_ci_prueba');
    const lines = message.payload.split('\r\n');
    expect(lines).toContain('MIME-Version: 1.0');
    expect(lines).toContain('Content-Type: multipart/alternative; boundary="=_ci_prueba"');
    expect(lines.filter((line) => line === '--=_ci_prueba')).toHaveLength(2);
    expect(lines.at(-2)).toBe('--=_ci_prueba--');
    expect(lines.at(-1)).toBe('.');
    const parts = message.payload.split('--=_ci_prueba');
    const decode = (part: string): string =>
      Buffer.from((part.split('\r\n\r\n')[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(parts[1]).toContain('Content-Type: text/plain; charset=utf-8');
    expect(decode(parts[1] ?? '')).toBe('Hola & adiós');
    expect(parts[2]).toContain('Content-Type: text/html; charset=utf-8');
    expect(decode(parts[2] ?? '')).toBe(html);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('el límite MIME es aleatorio en cada mensaje', () => {
    const first = prepareSmtpMessage({ ...base, html: '<p>x</p>' }).payload;
    const second = prepareSmtpMessage({ ...base, html: '<p>x</p>' }).payload;
    const boundary = (payload: string): string => /boundary="([^"]+)"/.exec(payload)?.[1] ?? '';
    expect(boundary(first)).toMatch(/^=_ci_[0-9a-f]{24}$/);
    expect(boundary(first)).not.toBe(boundary(second));
  });
});

describe('sendSmtpMail', () => {
  let server: Server;
  let connections = 0;
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('con el destinatario del hallazgo lanza sin abrir la conexión ni escribir en el socket', async () => {
    await expect(sendSmtpMail({ ...base, port, to: INJECTED_TO })).rejects.toBeInstanceOf(UnsafeMailFieldError);
    expect(connections).toBe(0);
  });
});

describe('NO_CONTROL_CHARS (fromName en PATCH /mail/settings)', () => {
  it('acepta un nombre normal y rechaza CR/LF', () => {
    expect(NO_CONTROL_CHARS.test('Control Interno UNAC — Oficina')).toBe(true);
    expect(NO_CONTROL_CHARS.test('Control\r\nBcc: x@evil.com')).toBe(false);
    expect(NO_CONTROL_CHARS.test('Control Interno')).toBe(false);
  });
});
