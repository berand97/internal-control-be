import path from 'node:path';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';

export const MAX_STORAGE_KEY_LENGTH = 1024;

// oxlint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

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
