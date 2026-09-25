import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';

const PAGE = { width: 612, height: 792 };
const MARGIN = 50;
const SLOT_TOP = 560;
const SLOT_HEIGHT = 118;
const GREY = rgb(0.35, 0.35, 0.35);

export interface PreparedSlot {
  readonly order: number;
  readonly label: string;
}

export interface PrepareInput {
  readonly title: string;
  readonly verifyUrl: string;
  readonly verificationCode: string;
  readonly originalSha256: string;
  readonly slots: ReadonlyArray<PreparedSlot>;
}

export interface SignatureMark {
  readonly slotIndex: number;
  readonly rubricPng: Buffer;
  readonly label: string;
  readonly name: string;
  readonly documentNumber: string | null;
  readonly signedAt: Date;
  readonly ipAddress: string | null;
}

const latin1 = (text: string): string =>
  text.replace(/[→]/g, '->').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

const slotY = (index: number): number => SLOT_TOP - index * SLOT_HEIGHT;

const write = (page: PDFPage, font: PDFFont, text: string, x: number, y: number, size: number, color = rgb(0, 0, 0)) =>
  page.drawText(latin1(text), { x, y, size, font, color });

const bogota = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'medium',
    timeZone: 'America/Bogota',
  }).format(date);

export const prepareForSignature = async (pdf: Buffer, input: PrepareInput): Promise<Buffer> => {
  const document = await PDFDocument.load(pdf);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const footer = `Documento con firma electrónica simple (Ley 527 de 1999, Decreto 2364 de 2012). Verifique en ${input.verifyUrl}`;
  const footerSize = footer.length > 150 ? 5.5 : 6.5;
  for (const page of document.getPages()) {
    write(page, font, footer, 20, 12, footerSize, GREY);
  }

  const page = document.addPage([PAGE.width, PAGE.height]);
  write(page, bold, 'Hoja de firmas', MARGIN, 740, 16);
  write(page, font, input.title, MARGIN, 720, 10);
  write(page, font, 'Firma electrónica simple. Verificación pública del documento:', MARGIN, 690, 9);
  write(page, font, input.verifyUrl, MARGIN, 677, 8, GREY);
  write(page, font, `Código de verificación: ${input.verificationCode}`, MARGIN, 660, 9);
  write(page, font, 'SHA-256 del documento generado:', MARGIN, 643, 8);
  write(page, font, input.originalSha256, MARGIN, 632, 7.5, GREY);
  const qr = await document.embedPng(await QRCode.toBuffer(input.verifyUrl, { margin: 1, width: 360 }));
  page.drawImage(qr, { x: PAGE.width - MARGIN - 110, y: 625, width: 110, height: 110 });

  input.slots.forEach((slot, index) => {
    const y = slotY(index);
    page.drawRectangle({
      x: MARGIN,
      y: y - SLOT_HEIGHT + 12,
      width: PAGE.width - 2 * MARGIN,
      height: SLOT_HEIGHT - 12,
      borderColor: GREY,
      borderWidth: 0.6,
    });
    write(page, bold, `${slot.order}. ${slot.label}`, MARGIN + 8, y - 14, 9);
  });
  return Buffer.from(await document.save());
};

export const stampSignature = async (pdf: Buffer, mark: SignatureMark): Promise<Buffer> => {
  const document = await PDFDocument.load(pdf);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.getPage(document.getPageCount() - 1);
  const y = slotY(mark.slotIndex);
  const image = await document.embedPng(mark.rubricPng);
  const scale = Math.min(200 / image.width, 70 / image.height, 1);
  page.drawImage(image, { x: MARGIN + 10, y: y - 98, width: image.width * scale, height: image.height * scale });
  const x = MARGIN + 240;
  write(page, font, mark.name, x, y - 32, 9);
  if (mark.documentNumber) {
    write(page, font, `Documento: ${mark.documentNumber}`, x, y - 46, 8);
  }
  write(page, font, `Firmó: ${bogota(mark.signedAt)}`, x, y - 60, 8);
  write(page, font, `Desde: ${mark.ipAddress ?? 'sin IP registrada'}`, x, y - 74, 8, GREY);
  write(page, font, `Rol: ${mark.label}`, x, y - 88, 8, GREY);
  return Buffer.from(await document.save());
};

export const isPng = (content: Buffer): boolean =>
  content.length > 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
