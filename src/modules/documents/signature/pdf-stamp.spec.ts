import { PDFDocument, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';

import { findSignatureAnchor, signatureAnchorText } from './pdf-anchors.js';
import { prepareForSignature, stampSignature } from './pdf-stamp.js';

const pageCount = async (pdf: Buffer): Promise<number> => (await PDFDocument.load(pdf)).getPageCount();

const bodyPdf = async (): Promise<Buffer> => {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('ENCARGADO:', { x: 72, y: 700, size: 12, font });
  page.drawText(signatureAnchorText('RESPONSABLE'), { x: 72, y: 640, size: 12, font });
  page.drawText('Gloria Estela', { x: 72, y: 620, size: 12, font });
  page.drawText('REVISA:', { x: 320, y: 700, size: 12, font });
  page.drawText(signatureAnchorText('AUDITA'), { x: 320, y: 640, size: 12, font });
  page.drawText('Sarita Lucia', { x: 320, y: 620, size: 12, font });
  return Buffer.from(await document.save());
};

describe('stampSignature', () => {
  it('estampa en el cuerpo sobre el ancla y mantiene la hoja de firmas con QR', async () => {
    const original = await bodyPdf();
    const prepared = await prepareForSignature(original, {
      title: 'OCI-21-37 · prueba',
      verifyUrl: 'https://example.invalid/verificar-firma/codigo',
      verificationCode: 'codigo',
      originalSha256: 'abc',
      slots: [
        { order: 1, label: 'Responsable' },
        { order: 2, label: 'Control Interno' },
      ],
    });
    expect(await pageCount(prepared)).toBe(2);
    expect(await findSignatureAnchor(prepared, 'RESPONSABLE')).not.toBeNull();
    expect(await findSignatureAnchor(prepared, 'AUDITA')).not.toBeNull();

    const rubricPng = await QRCode.toBuffer('rubrica-responsable', { width: 160, margin: 0 });
    const stamped = await stampSignature(prepared, {
      slotIndex: 0,
      role: 'RESPONSABLE',
      rubricPng,
      label: 'Responsable',
      name: 'Gloria Estela',
      documentNumber: '100',
      signedAt: new Date('2026-09-10T15:00:00Z'),
      ipAddress: '10.0.0.1',
      methodLabel: 'Enlace de un solo uso',
    });
    expect(await pageCount(stamped)).toBe(2);

    const second = await stampSignature(stamped, {
      slotIndex: 1,
      role: 'AUDITA',
      rubricPng: await QRCode.toBuffer('rubrica-audita', { width: 160, margin: 0 }),
      label: 'Control Interno',
      name: 'Sarita Lucia',
      documentNumber: '200',
      signedAt: new Date('2026-09-10T16:00:00Z'),
      ipAddress: '10.0.0.2',
      methodLabel: 'Sesión con MFA',
    });
    expect(await pageCount(second)).toBe(2);
  });

  it('sigue estampando la hoja si el PDF no tiene ancla del rol', async () => {
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    const original = Buffer.from(await document.save());
    const prepared = await prepareForSignature(original, {
      title: 'Sin anclas',
      verifyUrl: 'https://example.invalid/v/x',
      verificationCode: 'x',
      originalSha256: 'sha',
      slots: [{ order: 1, label: 'Recibe' }],
    });
    const stamped = await stampSignature(prepared, {
      slotIndex: 0,
      role: 'RECIBE',
      rubricPng: await QRCode.toBuffer('rubrica', { width: 120 }),
      label: 'Recibe',
      name: 'Ana',
      documentNumber: null,
      signedAt: new Date(),
      ipAddress: null,
      methodLabel: 'Sesión',
    });
    expect(await pageCount(stamped)).toBe(2);
  });
});
