import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpAuthOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username?: string | null;
  readonly password?: string | null;
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
  const socket = await openSession(options);
  try {
    await deliver(socket, options);
  } finally {
    socket.destroy();
  }
}

async function openSession(options: SmtpAuthOptions): Promise<SmtpSocket> {
  let socket: SmtpSocket = options.secure
    ? await connectTls(options.host, options.port)
    : await connectTcp(options.host, options.port);
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

async function deliver(socket: SmtpSocket, options: SmtpSendOptions): Promise<void> {
  await command(socket, `MAIL FROM:<${extractSmtpAddress(options.from)}>`, 250);
  await command(socket, `RCPT TO:<${options.to}>`, 250);
  await command(socket, 'DATA', 354);
  const payload = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(options.subject, 'utf8').toString('base64')}?=`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.text.replace(/^\./gm, '..'),
    '.',
  ].join(CRLF);
  await command(socket, payload, 250);
  await command(socket, 'QUIT', 221);
}

function connectTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port }, () => resolve(socket));
    socket.setTimeout(12_000, () => {
      socket.destroy();
      reject(new Error('Tiempo de espera agotado al conectar con el SMTP'));
    });
    socket.once('error', reject);
  });
}

function connectTls(host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host }, () =>
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
