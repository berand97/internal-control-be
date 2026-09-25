import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const pdfText = async (pdf: Buffer): Promise<string> => {
  const document = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const content = await (await document.getPage(number)).getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
        .join(''),
    );
  }
  await document.destroy();
  return pages.join('\n');
};

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface Sample {
  readonly names: ReadonlyArray<string>;
  readonly documents: ReadonlyArray<string>;
  readonly numbers: ReadonlyArray<string>;
  readonly text: ReadonlyArray<string>;
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

export const sampleLeftovers = (text: string, sample: Sample, options: { readonly numbers: boolean }): string[] => {
  const folded = fold(text);
  const compact = text.replace(/[.\s]/g, '');
  const found = [
    ...sample.names.filter((value) => new RegExp(`\\b${fold(value)}\\b`).test(folded)),
    ...sample.documents.filter((value) => compact.includes(value)),
    ...sample.text.filter((value) => folded.includes(fold(value))),
    ...(options.numbers ? sample.numbers.filter((value) => new RegExp(`(^|\\D)${value}(\\D|$)`).test(text)) : []),
  ];
  if (/docs\.google|drive\.google/i.test(text)) {
    found.push('enlace de Google');
  }
  if (text.includes('{{') || text.includes('}}')) {
    found.push('marcador sin reemplazar');
  }
  return found;
};

export class DocxTextPdfConverter {
  async toPdf(docx: Buffer): Promise<Buffer> {
    const { default: PizZip } = await import('pizzip');
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const zip = new PizZip(docx);
    const lines = ['word/header1.xml', 'word/document.xml']
      .flatMap((name) => [...(zip.file(name)?.asText() ?? '').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)])
      .map((paragraph) => [...paragraph[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((run) => run[1]).join(''))
      .map((line) => line.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'))
      .filter((line) => line.trim() !== '');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    let page = pdf.addPage([612, 792]);
    let y = 760;
    for (const line of lines) {
      for (let start = 0; start < line.length; start += 110) {
        if (y < 40) {
          page = pdf.addPage([612, 792]);
          y = 760;
        }
        page.drawText(line.slice(start, start + 110), { x: 30, y, size: 8, font });
        y -= 11;
      }
    }
    return Buffer.from(await pdf.save());
  }
}
