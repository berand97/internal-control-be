import { inflateRawSync } from 'node:zlib';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

const MIB = 1024 * 1024;

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
}

export const ZIP_LIMITS = {
  XLSX: { maxEntries: 1000, maxUncompressedBytes: 64 * MIB },
  DOCX: { maxEntries: 1000, maxUncompressedBytes: 50 * MIB },
} as const satisfies Record<string, ZipLimits>;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

const tooLarge = (detail: string): ApiException =>
  new ApiException(ErrorCode.ArchiveTooLarge, `El archivo es demasiado grande para procesarlo. ${detail}`);

const corrupt = (): ApiException =>
  new ApiException(ErrorCode.FileTypeNotAllowed, 'El archivo está dañado o no es un documento de Office.');

const findEndOfCentralDirectory = (content: Buffer): number => {
  const stop = Math.max(0, content.length - EOCD_MIN - MAX_COMMENT);
  for (let offset = content.length - EOCD_MIN; offset >= stop; offset -= 1) {
    if (content.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
};

const within = (content: Buffer, offset: number, length: number): boolean =>
  offset >= 0 && length >= 0 && offset + length <= content.length;

export const assertZipWithinLimits = (content: Buffer, limits: ZipLimits): void => {
  if (content.length < EOCD_MIN) {
    return;
  }
  const eocd = findEndOfCentralDirectory(content);
  if (eocd < 0) {
    return;
  }
  const entries = content.readUInt16LE(eocd + 10);
  const centralSize = content.readUInt32LE(eocd + 12);
  const centralOffset = content.readUInt32LE(eocd + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw tooLarge('Use un archivo más pequeño.');
  }
  if (entries > limits.maxEntries) {
    throw tooLarge(`Tiene ${entries} partes internas y el máximo es ${limits.maxEntries}.`);
  }
  if (!within(content, centralOffset, centralSize)) {
    throw corrupt();
  }

  let cursor = centralOffset;
  let declaredTotal = 0;
  const pending: Array<{ method: number; compressed: number; uncompressed: number; local: number }> = [];
  for (let index = 0; index < entries; index += 1) {
    if (!within(content, cursor, 46) || content.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw corrupt();
    }
    const method = content.readUInt16LE(cursor + 10);
    const compressed = content.readUInt32LE(cursor + 20);
    const uncompressed = content.readUInt32LE(cursor + 24);
    const nameLength = content.readUInt16LE(cursor + 28);
    const extraLength = content.readUInt16LE(cursor + 30);
    const commentLength = content.readUInt16LE(cursor + 32);
    const local = content.readUInt32LE(cursor + 42);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff) {
      throw tooLarge('Use un archivo más pequeño.');
    }
    declaredTotal += uncompressed;
    if (declaredTotal > limits.maxUncompressedBytes) {
      throw tooLarge(
        `Descomprimido pasa de ${Math.round(limits.maxUncompressedBytes / MIB)} MB.`,
      );
    }
    pending.push({ method, compressed, uncompressed, local });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  for (const entry of pending) {
    if (!within(content, entry.local, 30) || content.readUInt32LE(entry.local) !== LOCAL_SIGNATURE) {
      throw corrupt();
    }
    const dataStart =
      entry.local + 30 + content.readUInt16LE(entry.local + 26) + content.readUInt16LE(entry.local + 28);
    if (!within(content, dataStart, entry.compressed)) {
      throw corrupt();
    }
    if (entry.method === 0) {
      if (entry.compressed !== entry.uncompressed) {
        throw corrupt();
      }
      continue;
    }
    if (entry.method !== 8) {
      throw corrupt();
    }
    let produced: number;
    try {
      produced = inflateRawSync(content.subarray(dataStart, dataStart + entry.compressed), {
        maxOutputLength: Math.max(1, entry.uncompressed),
      }).length;
    } catch (error) {
      if (error instanceof RangeError) {
        throw tooLarge('Una parte interna está dañada.');
      }
      throw corrupt();
    }
    if (produced > entry.uncompressed) {
      throw tooLarge('Una parte interna está dañada.');
    }
  }
};
