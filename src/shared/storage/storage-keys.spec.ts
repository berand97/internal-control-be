import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import {
  documentFileKey,
  documentTemplateKey,
  emailImageKey,
  importTemplateKey,
  isPublicKey,
  safeKeySegment,
  signaturePreparedPdfKey,
  signatureRubricKey,
  signatureStampedPdfKey,
  signedDocumentKey,
  storageYear,
} from './storage-keys.js';

const DOC_ID = '0b6f5c2e-1a2b-4c3d-8e9f-0123456789ab';
const UUID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const CODE = 'AbC_dEf-123456789012345678901234';
const JUNE = new Date('2026-06-15T15:00:00Z');
const invalid = { code: ErrorCode.StorageKeyInvalid };

describe('storageYear (America/Bogota)', () => {
  it('1 de enero 03:00 UTC sigue siendo 31 de diciembre en Bogotá', () => {
    expect(storageYear(new Date('2027-01-01T03:00:00Z'))).toBe('2026');
    expect(storageYear(new Date('2027-01-01T05:00:00Z'))).toBe('2027');
  });

  it('fecha inválida: STORAGE_KEY_INVALID', () => {
    expect(() => storageYear(new Date('x'))).toThrow(expect.objectContaining(invalid));
  });
});

describe('documentos', () => {
  const base = { createdAt: JUNE, formatKey: 'OCI-01-55', number: '2026-0001' };

  it('docx, pdf, reemisión y firmado', () => {
    expect(documentFileKey({ ...base, extension: 'docx' })).toBe('documents/2026/OCI-01-55/2026-0001.docx');
    expect(documentFileKey({ ...base, extension: 'pdf' })).toBe('documents/2026/OCI-01-55/2026-0001.pdf');
    expect(documentFileKey({ ...base, extension: 'pdf', revision: 2 })).toBe('documents/2026/OCI-01-55/2026-0001-r2.pdf');
    expect(signedDocumentKey(base)).toBe('documents/2026/OCI-01-55/2026-0001-firmado.pdf');
  });

  it('el año es el de creación: un acta de diciembre firmada en enero queda en diciembre', () => {
    const december = { ...base, createdAt: new Date('2026-12-31T23:30:00-05:00') };
    expect(signedDocumentKey(december)).toMatch(/^documents\/2026\//);
  });

  it.each([
    ['../../etc', '..'],
    ['a/b', '/'],
    ['images/email/x', 'images'],
  ])('un número con %s no inyecta carpetas', (number) => {
    const key = documentFileKey({ ...base, number, extension: 'pdf' });
    expect(key.startsWith('documents/2026/OCI-01-55/')).toBe(true);
    expect(key.split('/')).toHaveLength(4);
    expect(key).not.toContain('..');
  });

  it('un formato con "/" o ".." se sanea sin salir de documents/<año>/', () => {
    const key = documentFileKey({ ...base, formatKey: '../images', extension: 'pdf' });
    expect(key.split('/')).toHaveLength(4);
    expect(key.split('/')[2]).toMatch(/^images-[0-9a-f]{8}$/);
    expect(isPublicKey(key)).toBe(false);
  });

  it('revisión negativa o no entera: STORAGE_KEY_INVALID', () => {
    expect(() => documentFileKey({ ...base, extension: 'pdf', revision: -1 })).toThrow(expect.objectContaining(invalid));
    expect(() => documentFileKey({ ...base, extension: 'pdf', revision: 1.5 })).toThrow(expect.objectContaining(invalid));
  });
});

describe('safeKeySegment', () => {
  it('deja intacto lo seguro', () => {
    expect(safeKeySegment('ACT-2026-0001')).toBe('ACT-2026-0001');
  });

  it('dos valores distintos que se sanean igual no comparten segmento', () => {
    const a = safeKeySegment('A/1');
    const b = safeKeySegment('A 1');
    expect(a).toMatch(/^A-1-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('valor sin nada utilizable: solo el hash', () => {
    expect(safeKeySegment('../..')).toMatch(/^[0-9a-f]{8}$/);
    expect(safeKeySegment('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('firmas', () => {
  const ref = { documentCreatedAt: JUNE, documentId: DOC_ID, verificationCode: CODE };

  it('v0, reemisión, rúbrica y versión estampada con el año del documento', () => {
    expect(signaturePreparedPdfKey(ref)).toBe(`signatures/2026/${DOC_ID}/${CODE}/v0.pdf`);
    expect(signaturePreparedPdfKey({ ...ref, originalSha256Prefix: 'abcdef0123456789' })).toBe(
      `signatures/2026/${DOC_ID}/${CODE}/v0-abcdef012345.pdf`,
    );
    expect(signatureRubricKey({ ...ref, order: 2 })).toBe(`signatures/2026/${DOC_ID}/${CODE}/rubrica-2.png`);
    expect(signatureStampedPdfKey({ ...ref, order: 2 })).toBe(`signatures/2026/${DOC_ID}/${CODE}/v2.pdf`);
  });

  it.each([
    ['documentId que no es uuid', { documentId: '../x' }],
    ['código con /', { verificationCode: 'abcdefgh/ijkl' }],
    ['código con ..', { verificationCode: 'abcdefgh..ijkl' }],
  ])('%s: STORAGE_KEY_INVALID', (_label, patch) => {
    expect(() => signatureRubricKey({ ...ref, ...patch, order: 1 })).toThrow(expect.objectContaining(invalid));
  });
});

describe('plantillas', () => {
  it('plantilla maestra con vigencia (sin año)', () => {
    expect(documentTemplateKey({ formatKey: 'OCI-01-55', effectiveDate: '2026-09-02', version: '2', id: UUID })).toBe(
      `templates/documents/OCI-01-55/2026-09-02-v2-${UUID}.docx`,
    );
  });

  it('plantilla heredada sin vigencia', () => {
    expect(documentTemplateKey({ formatKey: 'LOAN_DELIVERY_ACT', version: 3, id: UUID })).toBe(
      `templates/documents/LOAN_DELIVERY_ACT/v3-${UUID}.docx`,
    );
  });

  it.each([
    ['versión con /', { version: 'a/b' }],
    ['versión con ..', { version: '1..2' }],
    ['fecha no ISO', { effectiveDate: '02/09/2026' }],
    ['id no uuid', { id: 'x' }],
  ])('%s: STORAGE_KEY_INVALID', (_label, patch) => {
    expect(() =>
      documentTemplateKey({ formatKey: 'OCI-01-55', effectiveDate: '2026-09-02', version: '2', id: UUID, ...patch }),
    ).toThrow(expect.objectContaining(invalid));
  });

  it('plantilla de importación', () => {
    expect(importTemplateKey({ target: 'PERSONS', version: 'a1b2c3d4e5', contentHash: '0123456789abcdef0123' })).toBe(
      'templates/imports/PERSONS/a1b2c3d4e5/0123456789abcdef.xlsx',
    );
    expect(() => importTemplateKey({ target: 'PERSONS', version: '../x', contentHash: 'ab' })).toThrow(
      expect.objectContaining(invalid),
    );
  });
});

describe('imágenes de correo', () => {
  it('images/email/<uuid>.<png|jpg>, única carpeta pública', () => {
    expect(emailImageKey(UUID, 'png')).toBe(`images/email/${UUID}.png`);
    expect(emailImageKey(UUID, 'jpg')).toBe(`images/email/${UUID}.jpg`);
    expect(isPublicKey(emailImageKey(UUID, 'png'))).toBe(true);
    expect(() => emailImageKey('../x', 'png')).toThrow(expect.objectContaining(invalid));
  });

  it('ninguna clave privada queda bajo images/', () => {
    const keys = [
      documentFileKey({ createdAt: JUNE, formatKey: 'images', number: 'email', extension: 'pdf' }),
      signedDocumentKey({ createdAt: JUNE, formatKey: 'images', number: '1' }),
      signatureRubricKey({ documentCreatedAt: JUNE, documentId: DOC_ID, verificationCode: CODE, order: 1 }),
      documentTemplateKey({ formatKey: 'images', version: 1, id: UUID }),
      importTemplateKey({ target: 'images', version: 'v', contentHash: 'ab' }),
    ];
    for (const key of keys) {
      expect(isPublicKey(key)).toBe(false);
    }
  });
});
