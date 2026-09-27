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

/** Palabra codificada RFC 2047 (UTF-8, base64): el nombre visible nunca se escribe en crudo en la cabecera. */
export const encodeHeaderWord = (value: string): string =>
  `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
