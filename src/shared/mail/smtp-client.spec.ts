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
    expect(headers).toEqual([
      `From: =?UTF-8?B?${Buffer.from('Control Interno UNAC').toString('base64')}?= <noreply@unac.edu.co>`,
      'To: ana.ruiz@unac.edu.co',
      `Subject: =?UTF-8?B?${Buffer.from('Firma\r\nBcc: x@evil.com').toString('base64')}?=`,
      'Content-Type: text/plain; charset=utf-8',
    ]);
  });

  it('normaliza el cuerpo a CRLF y duplica el punto inicial: un LF suelto no cierra el DATA', () => {
    const message = prepareSmtpMessage({ ...base, text: 'hola\n.\nMAIL FROM:<x@evil.com>\r.\r\nfin' });
    expect(message.payload.endsWith('\r\nfin\r\n.')).toBe(true);
    expect(message.payload).not.toMatch(/\r\n\.\r\n(?!$)/);
    expect(message.payload).toContain('hola\r\n..\r\nMAIL FROM:<x@evil.com>\r\n..\r\nfin');
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
