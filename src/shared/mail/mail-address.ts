const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL_CLASS = `\u0000-\u001f\u007f${LINE_SEPARATORS}`;
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(`[${CONTROL_CLASS}]`);
// oxlint-disable-next-line no-control-regex
export const NO_CONTROL_CHARS = new RegExp(`^[^${CONTROL_CLASS}]*$`);

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

const ENCODED_WORD_BYTES = 39;

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

export const maskEmail = (value: string | null | undefined): string => {
  const text = (value ?? '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1 || hasControlChars(text)) {
    return '***';
  }
  return `${text.slice(0, 1)}***@${text.slice(at + 1)}`;
};

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

export const redactEmails = (text: string): string =>
  text.replace(EMAIL_IN_TEXT, (match) => maskEmail(match));
