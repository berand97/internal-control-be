import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfTextAnchor {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const signatureAnchorText = (role: string): string => `«FIRMA:${role}»`;

const ANCHOR_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  AUDITA: ['AUDITA', 'CONTROL_INTERNO'],
  CONTROL_INTERNO: ['CONTROL_INTERNO', 'AUDITA'],
};

export const signatureAnchorCandidates = (role: string): string[] => {
  const roles = ANCHOR_ALIASES[role] ?? [role];
  return [...new Set(roles.map(signatureAnchorText))];
};

interface TextItem {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const itemsOf = async (pdf: Buffer): Promise<Array<{ pageIndex: number; items: TextItem[] }>> => {
  const document = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const pages: Array<{ pageIndex: number; items: TextItem[] }> = [];
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str) {
          continue;
        }
        const transform = item.transform as number[];
        items.push({
          str: item.str,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: item.width,
          height: item.height || Math.abs(transform[3] ?? 10),
        });
      }
      pages.push({ pageIndex: number - 1, items });
    }
  } finally {
    await document.destroy();
  }
  return pages;
};

const matchOnPage = (items: ReadonlyArray<TextItem>, needle: string): Omit<PdfTextAnchor, 'pageIndex'> | null => {
  for (let index = 0; index < items.length; index += 1) {
    let built = '';
    let x = items[index]!.x;
    let y = items[index]!.y;
    let width = 0;
    let height = items[index]!.height;
    for (let end = index; end < items.length && built.length < needle.length + 8; end += 1) {
      const part = items[end]!;
      if (end > index) {
        const gap = part.x - (items[end - 1]!.x + items[end - 1]!.width);
        if (gap > 8 || Math.abs(part.y - y) > 2) {
          break;
        }
      }
      if (end === index) {
        x = part.x;
        y = part.y;
      }
      built += part.str;
      width = part.x + part.width - x;
      height = Math.max(height, part.height);
      if (built === needle) {
        return { x, y, width: Math.max(width, 1), height: Math.max(height, 8) };
      }
      if (!needle.startsWith(built)) {
        break;
      }
    }
  }
  return null;
};

export const findTextAnchor = async (pdf: Buffer, needle: string): Promise<PdfTextAnchor | null> => {
  for (const page of await itemsOf(pdf)) {
    const found = matchOnPage(page.items, needle);
    if (found) {
      return { ...found, pageIndex: page.pageIndex };
    }
  }
  return null;
};

export const findSignatureAnchor = async (pdf: Buffer, role: string): Promise<PdfTextAnchor | null> => {
  for (const needle of signatureAnchorCandidates(role)) {
    const found = await findTextAnchor(pdf, needle);
    if (found) {
      return found;
    }
  }
  return null;
};
