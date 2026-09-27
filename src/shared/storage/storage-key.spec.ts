import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { itemPath } from './adapters/onedrive-storage.adapter.js';
import { ProjectStorageAdapter } from './adapters/project-storage.adapter.js';
import { assertSafeStorageKey, resolveInsideRoot } from './storage-key.js';

const rejectsKey = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe(ErrorCode.StorageKeyInvalid);
    return;
  }
  throw new Error('se esperaba STORAGE_KEY_INVALID');
};

describe('assertSafeStorageKey', () => {
  it.each([
    'documents/OCI-01-55/2026/ACT-0001.pdf',
    'signatures/0b6f/ABC123/v0.pdf',
    'import-templates/assets/3/0123456789abcdef.xlsx',
    'health/1767225760000.txt',
    'templates/ACTA/..v2.docx',
  ])('acepta la clave real %s', (key) => {
    expect(assertSafeStorageKey(key)).toBe(key);
  });

  it.each([
    ['vacía', ''],
    ['absoluta', '/etc/passwd'],
    ['absoluta del hermano', '/data/storage-old/x'],
    ['proc', '/proc/self/environ'],
    ['.. al inicio', '../x'],
    ['.. en medio', 'a/../../x'],
    ['.. al final', 'a/..'],
    ['segmento .', 'a/./b'],
    ['segmento vacío', 'a//b'],
    ['barra final', 'a/'],
    ['barra invertida', 'a\\..\\..\\x'],
    ['letra de unidad', 'C:/Windows/win.ini'],
    ['NUL', 'a/b\u0000.pdf'],
    ['CR/LF', 'a/b\r\n.pdf'],
    ['demasiado larga', `a/${'x'.repeat(1100)}`],
  ])('rechaza clave %s', (_label, key) => {
    rejectsKey(() => assertSafeStorageKey(key));
  });

  it.each([undefined, null, 42, ['a', 'b']])('rechaza %j (query ausente o repetida)', (key) => {
    rejectsKey(() => assertSafeStorageKey(key));
  });

  it('el error no repite la clave', () => {
    try {
      assertSafeStorageKey('/proc/self/environ');
    } catch (error) {
      expect((error as Error).message).not.toContain('environ');
    }
  });
});

describe('resolveInsideRoot', () => {
  const root = path.resolve('/data/storage');

  it('resuelve dentro de la raíz', () => {
    expect(resolveInsideRoot(root, 'documents/a.pdf')).toBe(path.join(root, 'documents', 'a.pdf'));
  });

  it('no deja escapar al hermano con el mismo prefijo (antes startsWith lo aceptaba)', () => {
    rejectsKey(() => resolveInsideRoot(root, '/data/storage-old/x'));
    rejectsKey(() => resolveInsideRoot(root, '../storage-old/x'));
  });

  it('rechaza la propia raíz', () => {
    rejectsKey(() => resolveInsideRoot(root, '.'));
  });
});

describe('ProjectStorageAdapter', () => {
  let base: string;
  let root: string;
  let sibling: string;
  let adapter: ProjectStorageAdapter;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'be01-'));
    root = path.join(base, 'storage');
    sibling = path.join(base, 'storage-old');
    await mkdir(root, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'secreto.txt'), 'no');
    await writeFile(path.join(base, 'fuera.txt'), 'no');
    adapter = new ProjectStorageAdapter(root, 'http://api');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('guarda y lee una clave válida', async () => {
    await adapter.put({ key: 'documents/x/a.pdf', body: Buffer.from('ok'), contentType: 'application/pdf' });
    expect((await adapter.get('documents/x/a.pdf')).toString()).toBe('ok');
    expect(await adapter.exists('documents/x/a.pdf')).toBe(true);
    await adapter.delete('documents/x/a.pdf');
    expect(await adapter.exists('documents/x/a.pdf')).toBe(false);
  });

  it.each([
    '../storage-old/secreto.txt',
    '../fuera.txt',
    'a/../../fuera.txt',
    '/etc/hostname',
  ])('get/exists/delete/put/presign rechazan %s con 400 y sin tocar disco', async (key) => {
    const absoluteSibling = path.join(sibling, 'secreto.txt');
    const keys = [key, absoluteSibling];
    for (const candidate of keys) {
      await expect(adapter.get(candidate)).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
      await expect(adapter.exists(candidate)).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
      await expect(adapter.delete(candidate)).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
      await expect(
        adapter.put({ key: candidate, body: Buffer.from('x'), contentType: 'text/plain' }),
      ).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
      await expect(adapter.presignGet(candidate)).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    }
    expect((await readFile(absoluteSibling)).toString()).toBe('no');
    expect((await readFile(path.join(base, 'fuera.txt'))).toString()).toBe('no');
  });
});

describe('OneDrive itemPath', () => {
  const config = { tenantId: 't', clientId: 'c', clientSecret: 's', refreshToken: 'r', folderId: 'Control Interno' };

  it('codifica cada segmento de la carpeta y la clave', () => {
    expect(itemPath(config, 'documents/a b?#.pdf')).toBe('root:/Control%20Interno/documents/a%20b%3F%23.pdf');
  });

  it('rechaza claves con .. que la URL normalizaría fuera de la carpeta', () => {
    rejectsKey(() => itemPath(config, '../../items/xyz'));
  });

  it('rechaza una carpeta configurada con ..', () => {
    expect(() => itemPath({ ...config, folderId: 'a/../..' }, 'x.pdf')).toThrow(ApiException);
  });
});
