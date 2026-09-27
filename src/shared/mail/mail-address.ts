/**
 * Validación de direcciones y cabeceras antes de hablar con el SMTP (BE-06). El cliente SMTP escribe `RCPT TO`,
 * `From:` y `To:` en líneas terminadas en CRLF: un CR, LF o NUL dentro de un valor abre un comando o una cabecera
 * nuevos. Nada de lo que se rechaza aquí se repite en el mensaje de error: son datos personales.
 */

// Caracteres de control (NUL, CR, LF, TAB...) y los separadores de línea y párrafo de Unicode (U+2028, U+2029).
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL_CLASS = `\u0000-\u001f\u007f${LINE_SEPARATORS}`;
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(`[${CONTROL_CLASS}]`);
/** Para @Matches en DTO: texto de una sola línea, sin caracteres de control. */
// oxlint-disable-next-line no-control-regex
export const NO_CONTROL_CHARS = new RegExp(`^[^${CONTROL_CLASS}]*$`);

// dot-atom (RFC 5321/5322) sin comillas ni comentarios: ninguna dirección real de la universidad los usa.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const MAILBOX = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})+$`);

export type MailField = 'to' | 'from' | 'fromName';

export class UnsafeMailFieldError extends Error {
  constructor(readonly field: MailField) {
    super(`El campo ${field} del correo no es válido`);
    this.name = 'UnsafeMailFieldError';
  }
}

export const hasControlChars = (value: string): boolean => CONTROL_CHARS.test(value);

/** Dirección simple (usuario@dominio), sin nombre, ángulos, espacios ni caracteres de control. */
export const isValidMailbox = (value: string): boolean => {
  if (value.length === 0 || value.length > 254 || hasControlChars(value)) {
    return false;
  }
  const at = value.lastIndexOf('@');
  return at > 0 && at <= 64 && MAILBOX.test(value);
};

export interface ParsedFrom {
  readonly name: string | null;
  readonly address: string;
}

/** `Nombre <correo>` o `correo`. Lanza UnsafeMailFieldError si el nombre o la dirección no son seguros. */
export const parseFrom = (from: string): ParsedFrom => {
  const match = /^([^<>]*)<([^<>]+)>$/.exec(from.trim());
  const name = match ? (match[1] ?? '').trim() : null;
  const address = match ? (match[2] ?? '').trim() : from.trim();
  if (name !== null && hasControlChars(name)) {
    throw new UnsafeMailFieldError('fromName');
  }
  if (!isValidMailbox(address)) {
    throw new UnsafeMailFieldError('from');
  }
  return { name: name === '' ? null : name, address };
};

/** Bytes UTF-8 por palabra codificada: 39 → 52 caracteres base64 + 12 de envoltura = 64; con "Subject: " la línea queda en 73 (RFC 5322 recomienda 78). */
const ENCODED_WORD_BYTES = 39;

/**
 * Palabra codificada RFC 2047 (UTF-8, base64): el nombre visible y el asunto nunca se escriben en crudo en la
 * cabecera. Un valor largo se parte en varias palabras (sin cortar un carácter) plegadas con CRLF + espacio, así
 * ninguna línea de cabecera supera los límites de RFC 5322.
 */
export const encodeHeaderWord = (value: string): string => {
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
};

/**
 * Correo enmascarado para logs (Ley 1581): primera letra del usuario y el dominio, `a***@unac.edu.co`.
 * Lo que no parece un correo se reemplaza entero.
 */
export const maskEmail = (value: string | null | undefined): string => {
  const text = (value ?? '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1 || hasControlChars(text)) {
    return '***';
  }
  return `${text.slice(0, 1)}***@${text.slice(at + 1)}`;
};

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/** Enmascara los correos que aparezcan en un texto libre (respuesta del SMTP, pila de un error) antes del log. */
export const redactEmails = (text: string): string =>
  text.replace(EMAIL_IN_TEXT, (match) => maskEmail(match));
