import { connect as netConnect, type LookupFunction, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import {
  assertHostShapeAllowed,
  guardedLookup,
  type OutboundPolicy,
} from '../net/outbound-destination.js';
import {
  encodeHeaderWord,
  isValidMailbox,
  parseFrom,
  UnsafeMailFieldError,
} from './mail-address.js';

export interface SmtpAuthOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username?: string | null;
  readonly password?: string | null;
  /** Política de destinos salientes (BE-16). Sin ella no se filtra (solo pruebas unitarias del protocolo). */
  readonly outbound?: OutboundPolicy;
}

export interface SmtpSendOptions extends SmtpAuthOptions {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

type SmtpSocket = Socket | TLSSocket;

const CRLF = '\r\n';

export async function verifySmtp(options: SmtpAuthOptions): Promise<void> {
  const socket = await openSession(options);
  try {
    await command(socket, 'QUIT', 221);
  } finally {
    socket.destroy();
  }
}

export async function sendSmtpMail(options: SmtpSendOptions): Promise<void> {
  // Se valida antes de conectar: un valor inseguro nunca llega a escribirse en el socket (BE-06).
  const message = prepareSmtpMessage(options);
  const socket = await openSession(options);
  try {
    await deliver(socket, message);
  } finally {
    socket.destroy();
  }
}

async function openSession(options: SmtpAuthOptions): Promise<SmtpSocket> {
  // IP literal o nombre interno: se rechaza sin abrir el socket. Los nombres se validan al resolverlos (lookup).
  const lookup = options.outbound ? guardedLookup(options.outbound) : undefined;
  if (options.outbound) {
    assertHostShapeAllowed(options.host, options.outbound);
  }
  let socket: SmtpSocket = options.secure
    ? await connectTls(options.host, options.port, lookup)
    : await connectTcp(options.host, options.port, lookup);
  await expectCode(socket, 220);
  if (!options.secure) {
    await command(socket, 'EHLO control-interno', 250);
    await command(socket, 'STARTTLS', 220);
    socket = await upgradeTls(socket as Socket, options.host);
  }
  await command(socket, 'EHLO control-interno', 250);
  if (options.username && options.password) {
    await command(socket, 'AUTH LOGIN', 334);
    await command(socket, Buffer.from(options.username).toString('base64'), 334);
    await command(socket, Buffer.from(options.password).toString('base64'), 235);
  }
  return socket;
}

export function extractSmtpAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match?.[1] ?? from;
}

export interface SmtpMessage {
  readonly mailFrom: string;
  readonly rcptTo: string;
  readonly payload: string;
}

/**
 * Arma los comandos y el mensaje (BE-06). Lanza UnsafeMailFieldError, sin el valor, si el destinatario o el
 * remitente no son una dirección simple o si el nombre del remitente trae CR, LF, NUL u otro carácter de control.
 * Los datos variables de las cabeceras van validados (direcciones) o codificados RFC 2047 (nombre y asunto), y el
 * cuerpo se normaliza a CRLF antes del dot-stuffing: un LF o CR suelto no puede cerrar el DATA.
 */
export function prepareSmtpMessage(options: SmtpSendOptions): SmtpMessage {
  const to = options.to.trim();
  if (!isValidMailbox(to)) {
    throw new UnsafeMailFieldError('to');
  }
  const from = parseFrom(options.from);
  const fromHeader = from.name
    ? `${encodeHeaderWord(from.name)} <${from.address}>`
    : from.address;
  const body = options.text.replace(/\r\n|\r|\n/g, CRLF).replace(/^\./gm, '..');
  const payload = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(options.subject)}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '.',
  ].join(CRLF);
  return {
    mailFrom: `MAIL FROM:<${from.address}>`,
    rcptTo: `RCPT TO:<${to}>`,
    payload,
  };
}

async function deliver(socket: SmtpSocket, message: SmtpMessage): Promise<void> {
  await command(socket, message.mailFrom, 250);
  await command(socket, message.rcptTo, 250);
  await command(socket, 'DATA', 354);
  await command(socket, message.payload, 250);
  await command(socket, 'QUIT', 221);
}

function connectTcp(host: string, port: number, lookup: LookupFunction | undefined): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port, ...(lookup ? { lookup } : {}) }, () => resolve(socket));
    socket.setTimeout(12_000, () => {
      socket.destroy();
      reject(new Error('Tiempo de espera agotado al conectar con el SMTP'));
    });
    socket.once('error', reject);
  });
}

function connectTls(host: string, port: number, lookup: LookupFunction | undefined): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host, ...(lookup ? { lookup } : {}) }, () =>
      resolve(socket),
    );
    socket.setTimeout(12_000, () => {
      socket.destroy();
      reject(new Error('Tiempo de espera agotado al conectar con el SMTP'));
    });
    socket.once('error', reject);
  });
}

function upgradeTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const upgraded = tlsConnect({ socket, servername: host }, () =>
      resolve(upgraded),
    );
    upgraded.once('error', reject);
  });
}

async function command(
  socket: SmtpSocket,
  line: string,
  expected: number,
): Promise<void> {
  socket.write(`${line}${CRLF}`);
  await expectCode(socket, expected);
}

function expectCode(socket: SmtpSocket, expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes(CRLF)) {
        return;
      }
      const lines = buffer.split(CRLF).filter((line) => line.length > 0);
      const last = lines.at(-1);
      if (!last || last[3] === '-') {
        return;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      const code = Number(last.slice(0, 3));
      if (code !== expected) {
        reject(new Error(`SMTP ${expected} esperado, llegó ${last}`));
        return;
      }
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}
