import path from 'node:path';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';

/** Longitud máxima de una clave (S3 admite 1024 bytes; el resto de drivers, menos). */
export const MAX_STORAGE_KEY_LENGTH = 1024;

// Caracteres de control (incluye NUL, CR y LF) y la barra invertida, que en Windows es separador.
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Una clave de almacenamiento es una ruta relativa con segmentos separados por '/':
 * no absoluta, sin segmentos vacíos, '.' ni '..', sin caracteres de control ni '\'.
 * Así ninguna clave puede salir de la carpeta o prefijo del driver (BE-01).
 * El error no repite la clave: puede venir de un parámetro de la petición.
 */
export const assertSafeStorageKey = (key: unknown): string => {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_STORAGE_KEY_LENGTH ||
    FORBIDDEN_CHARS.test(key) ||
    key.startsWith('/') ||
    DRIVE_LETTER.test(key)
  ) {
    throw new ApiException(ErrorCode.StorageKeyInvalid);
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ApiException(ErrorCode.StorageKeyInvalid);
    }
  }
  return key;
};

/**
 * Ruta absoluta de `key` dentro de `root`. Además de validar la clave, comprueba la contención
 * con path.relative (no con startsWith, que aceptaba el hermano `/data/storage-old` de `/data/storage`).
 */
export const resolveInsideRoot = (root: string, key: string): string => {
  const safeKey = assertSafeStorageKey(key);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, safeKey);
  const relative = path.relative(absoluteRoot, absolute);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ApiException(ErrorCode.StorageKeyInvalid);
  }
  return absolute;
};
