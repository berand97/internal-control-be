import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
  findSignatureAnchor,
  findTextAnchor,
  signatureAnchorCandidates,
  signatureAnchorText,
} from './pdf-anchors.js';

const pdfWith = async (lines: ReadonlyArray<string>): Promise<Buffer> => {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  let y = 700;
  for (const line of lines) {
    page.drawText(line, { x: 72, y, size: 12, font });
    y -= 24;
  }
  return Buffer.from(await document.save());
};

describe('pdf-anchors', () => {
  it('arma el texto de ancla y alias de Control Interno', () => {
    expect(signatureAnchorText('RESPONSABLE')).toBe('«FIRMA:RESPONSABLE»');
    expect(signatureAnchorCandidates('AUDITA')).toEqual(['«FIRMA:AUDITA»', '«FIRMA:CONTROL_INTERNO»']);
    expect(signatureAnchorCandidates('CONTROL_INTERNO')).toEqual(['«FIRMA:CONTROL_INTERNO»', '«FIRMA:AUDITA»']);
  });

  it('localiza anclas en el PDF', async () => {
    const pdf = await pdfWith(['ENCARGADO:', '«FIRMA:RESPONSABLE»', 'Nombre']);
    const found = await findTextAnchor(pdf, '«FIRMA:RESPONSABLE»');
    expect(found).toMatchObject({ pageIndex: 0, x: expect.any(Number), y: expect.any(Number) });
    expect(found!.x).toBeGreaterThan(50);
    expect(found!.y).toBeGreaterThan(600);

    const byRole = await findSignatureAnchor(pdf, 'RESPONSABLE');
    expect(byRole?.pageIndex).toBe(0);

    expect(await findSignatureAnchor(pdf, 'AUDITA')).toBeNull();
  });

  it('resuelve AUDITA vía alias CONTROL_INTERNO', async () => {
    const pdf = await pdfWith(['«FIRMA:CONTROL_INTERNO»']);
    const found = await findSignatureAnchor(pdf, 'AUDITA');
    expect(found?.pageIndex).toBe(0);
  });
});
