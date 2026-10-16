import { createHash } from 'node:crypto';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { assertSafeStorageKey } from './storage-key.js';

export const PUBLIC_KEY_PREFIX = 'images/';
export const EMAIL_IMAGE_KEY_PREFIX = 'images/email/';

const TIME_ZONE = 'America/Bogota';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YEAR = /^\d{4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERIFICATION_CODE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX = /^[0-9a-f]+$/;

const invalid = (): ApiException => new ApiException(ErrorCode.StorageKeyInvalid);

const checked = (value: string, pattern: RegExp): string => {
  if (!pattern.test(value) || value.includes('..')) {
    throw invalid();
  }
  return value;
};

const positiveInt = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid();
  }
  return value;
};

export const safeKeySegment = (raw: string): string => {
  if (SAFE_SEGMENT.test(raw) && !raw.includes('..')) {
    return raw;
  }
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 100)
    .replace(/[-.]+$/, '');
  const suffix = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return cleaned ? `${cleaned}-${suffix}` : suffix;
};

export const storageYear = (instant: Date): string => {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw invalid();
  }
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric' }).format(instant);
  return checked(year, YEAR);
};

const finish = (key: string): string => {
  assertSafeStorageKey(key);
  return key;
};

export interface DocumentKeyInput {
  readonly createdAt: Date;
  readonly formatKey: string;
  readonly number: string;
}

export const documentFileKey = (
  input: DocumentKeyInput & { readonly extension: 'docx' | 'pdf'; readonly revision?: number },
): string => {
  const revision = input.revision === undefined ? '' : `-r${positiveInt(input.revision)}`;
  return finish(
    `documents/${storageYear(input.createdAt)}/${safeKeySegment(input.formatKey)}/${safeKeySegment(input.number)}${revision}.${input.extension}`,
  );
};

export const signedDocumentKey = (input: DocumentKeyInput): string =>
  finish(`documents/${storageYear(input.createdAt)}/${safeKeySegment(input.formatKey)}/${safeKeySegment(input.number)}-firmado.pdf`);

export interface SignatureKeyInput {
  readonly documentCreatedAt: Date;
  readonly documentId: string;
  readonly verificationCode: string;
}

const signatureFolder = (input: SignatureKeyInput): string =>
  `signatures/${storageYear(input.documentCreatedAt)}/${checked(input.documentId, UUID)}/${checked(input.verificationCode, VERIFICATION_CODE)}`;

export const signaturePreparedPdfKey = (input: SignatureKeyInput & { readonly originalSha256Prefix?: string }): string => {
  const suffix =
    input.originalSha256Prefix === undefined ? '' : `-${checked(input.originalSha256Prefix, HEX).slice(0, 12)}`;
  return finish(`${signatureFolder(input)}/v0${suffix}.pdf`);
};

export const signatureRubricKey = (input: SignatureKeyInput & { readonly order: number }): string =>
  finish(`${signatureFolder(input)}/rubrica-${positiveInt(input.order)}.png`);

export const signatureStampedPdfKey = (input: SignatureKeyInput & { readonly order: number }): string =>
  finish(`${signatureFolder(input)}/v${positiveInt(input.order)}.pdf`);

export const documentTemplateKey = (input: {
  readonly formatKey: string;
  readonly version: string | number;
  readonly id: string;
  readonly effectiveDate?: string;
}): string => {
  const date = input.effectiveDate === undefined ? '' : `${checked(input.effectiveDate, ISO_DATE)}-`;
  const version = checked(String(input.version), /^[A-Za-z0-9._-]{1,20}$/);
  return finish(
    `templates/documents/${safeKeySegment(input.formatKey)}/${date}v${version}-${checked(input.id, UUID)}.docx`,
  );
};

export const importTemplateKey = (input: {
  readonly target: string;
  readonly version: string;
  readonly contentHash: string;
}): string =>
  finish(
    `templates/imports/${safeKeySegment(input.target)}/${checked(input.version, SAFE_SEGMENT)}/${checked(input.contentHash, HEX).slice(0, 16)}.xlsx`,
  );

export const emailImageKey = (id: string, extension: 'png' | 'jpg'): string =>
  finish(`${EMAIL_IMAGE_KEY_PREFIX}${checked(id, UUID)}.${extension}`);

export const isPublicKey = (key: string): boolean => key.startsWith(PUBLIC_KEY_PREFIX);
