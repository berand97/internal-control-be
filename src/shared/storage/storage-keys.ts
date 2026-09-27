import { createHash } from 'node:crypto';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { assertSafeStorageKey } from './storage-key.js';

/**
 * Única fuente de las claves de almacenamiento (docs/DEPLOY.md §10.5). Organización del bucket:
 *
 *   images/email/<uuid>.png|jpg                                   ← única carpeta pública (lectura anónima)
 *   documents/<año>/<formato>/<número>.docx|.pdf                  actas generadas (…-rN al reemitir)
 *   documents/<año>/<formato>/<número>-firmado.pdf                versión firmada
 *   signatures/<año>/<documentId>/<código>/v0.pdf, rubrica-N.png, vN.pdf
 *   templates/documents/<formato>/<vigencia>-vN-<uuid>.docx       plantillas maestras (sin año)
 *   templates/imports/<destino>/<versión>/<hash>.xlsx
 *   health/…                                                      sondas de "Probar conexión" (s3-connection-probe.ts)
 *
 * <año> es el año de CREACIÓN del documento en America/Bogota, fijo: un acta creada en diciembre y firmada en enero
 * sigue en la carpeta del año de creación, y sus firmas también. Los objetos anteriores a esta organización no se
 * mueven: cada fila guarda su clave y se lee con ella.
 *
 * Funciones puras (sin E/S): cada segmento se valida o se sanea aquí, así ningún dato (número, formato, código) puede
 * inyectar '/', '..' ni caer bajo images/ (la carpeta pública). Un error no repite el valor recibido.
 */

/** Prefijo de lo único que puede ser público. Ninguna clave privada puede empezar por él. */
export const PUBLIC_KEY_PREFIX = 'images/';
/** Prefijo de las imágenes de las plantillas de correo (la política anónima solo deja leer aquí). */
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

/**
 * Segmento seguro a partir de un dato de negocio (número de acta, clave de formato, destino). Si ya es seguro se
 * usa tal cual; si no, los caracteres no admitidos se cambian por '-' y se añade un sufijo del sha256 del valor
 * original, para que dos valores distintos nunca compartan clave (y no se pisen objetos).
 */
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

/** Año (AAAA) del instante en Bogotá: la carpeta de un documento y de sus firmas. */
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

// ─── Documentos (actas) ──────────────────────────────────────────────────────────────────────────────────────────

export interface DocumentKeyInput {
  /** Instante de creación del documento (document.created_at). */
  readonly createdAt: Date;
  /** Clave del formato (document.format_key) o tipo de documento heredado. */
  readonly formatKey: string;
  /** Número del acta. */
  readonly number: string;
}

/** documents/<año>/<formato>/<número>[-rN].<docx|pdf>; revision > 0 al reemitir con otro firmante. */
export const documentFileKey = (
  input: DocumentKeyInput & { readonly extension: 'docx' | 'pdf'; readonly revision?: number },
): string => {
  const revision = input.revision === undefined ? '' : `-r${positiveInt(input.revision)}`;
  return finish(
    `documents/${storageYear(input.createdAt)}/${safeKeySegment(input.formatKey)}/${safeKeySegment(input.number)}${revision}.${input.extension}`,
  );
};

/** documents/<año>/<formato>/<número>-firmado.pdf */
export const signedDocumentKey = (input: DocumentKeyInput): string =>
  finish(`documents/${storageYear(input.createdAt)}/${safeKeySegment(input.formatKey)}/${safeKeySegment(input.number)}-firmado.pdf`);

// ─── Firmas ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SignatureKeyInput {
  /** Instante de creación del documento firmado: las firmas van en la carpeta del año del documento. */
  readonly documentCreatedAt: Date;
  readonly documentId: string;
  readonly verificationCode: string;
}

const signatureFolder = (input: SignatureKeyInput): string =>
  `signatures/${storageYear(input.documentCreatedAt)}/${checked(input.documentId, UUID)}/${checked(input.verificationCode, VERIFICATION_CODE)}`;

/** …/v0.pdf (PDF preparado); al reemitir, …/v0-<12 hex del sha256 original>.pdf. */
export const signaturePreparedPdfKey = (input: SignatureKeyInput & { readonly originalSha256Prefix?: string }): string => {
  const suffix =
    input.originalSha256Prefix === undefined ? '' : `-${checked(input.originalSha256Prefix, HEX).slice(0, 12)}`;
  return finish(`${signatureFolder(input)}/v0${suffix}.pdf`);
};

/** …/rubrica-<orden>.png */
export const signatureRubricKey = (input: SignatureKeyInput & { readonly order: number }): string =>
  finish(`${signatureFolder(input)}/rubrica-${positiveInt(input.order)}.png`);

/** …/v<orden>.pdf (PDF con la firma de ese turno estampada). */
export const signatureStampedPdfKey = (input: SignatureKeyInput & { readonly order: number }): string =>
  finish(`${signatureFolder(input)}/v${positiveInt(input.order)}.pdf`);

// ─── Plantillas ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * templates/documents/<formato>/<vigencia>-v<versión>-<uuid>.docx. Sin fecha de vigencia (plantillas heredadas de
 * document_template, que no la tienen): templates/documents/<tipo>/v<versión>-<uuid>.docx.
 */
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

/** templates/imports/<destino>/<versión>/<hash>.xlsx (hash: 16 hex del contenido). */
export const importTemplateKey = (input: {
  readonly target: string;
  readonly version: string;
  readonly contentHash: string;
}): string =>
  finish(
    `templates/imports/${safeKeySegment(input.target)}/${checked(input.version, SAFE_SEGMENT)}/${checked(input.contentHash, HEX).slice(0, 16)}.xlsx`,
  );

// ─── Imágenes públicas de correo ─────────────────────────────────────────────────────────────────────────────────

/** images/email/<uuid>.<png|jpg>: no adivinable y sin el nombre original. */
export const emailImageKey = (id: string, extension: 'png' | 'jpg'): string =>
  finish(`${EMAIL_IMAGE_KEY_PREFIX}${checked(id, UUID)}.${extension}`);

/** true si la clave está bajo la carpeta pública (images/). */
export const isPublicKey = (key: string): boolean => key.startsWith(PUBLIC_KEY_PREFIX);
