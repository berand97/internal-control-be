import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  extractPlaceholders,
  nestContext,
} from './placeholder-catalog.js';

const xmlFromZip = (zip: PizZip): string => {
  const names = Object.keys(zip.files).filter((name) =>
    /^word\/(document|header\d+|footer\d+)\.xml$/.test(name),
  );
  return names
    .map((name) => {
      const file = zip.file(name);
      return file ? file.asText() : '';
    })
    .join('\n');
};

export const readDocxPlaceholders = (buffer: Buffer): ReadonlyArray<string> => {
  try {
    const zip = new PizZip(buffer);
    return extractPlaceholders(xmlFromZip(zip));
  } catch {
    throw new ApiException(ErrorCode.TemplateInvalidDocx);
  }
};

export const renderDocx = (
  buffer: Buffer,
  context: Record<string, unknown>,
): Buffer => {
  try {
    const zip = new PizZip(buffer);
    const document = new Docxtemplater(zip, {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
      parser: dottedPathParser,
    });
    document.render(nestContext(context));
    return Buffer.from(document.getZip().generate({ type: 'nodebuffer' }));
  } catch (error) {
    throw new ApiException(ErrorCode.TemplateInvalidDocx, templateErrorMessage(error));
  }
};

const dottedPathParser = (tag: string) => ({
  get: (scope: unknown): unknown =>
    tag === '.'
      ? scope
      : tag
          .trim()
          .split('.')
          .reduce<unknown>(
            (value, key) =>
              typeof value === 'object' && value !== null
                ? (value as Record<string, unknown>)[key]
                : undefined,
            scope,
          ),
});

const templateErrorMessage = (error: unknown): string | undefined => {
  const nested = (error as { properties?: { errors?: Array<{ properties?: { explanation?: string } }> } })
    .properties?.errors;
  const explanations = nested?.map((item) => item.properties?.explanation).filter(Boolean);
  if (explanations && explanations.length > 0) {
    return `Plantilla inválida: ${explanations.slice(0, 3).join('; ')}`;
  }
  return error instanceof Error ? `Plantilla inválida: ${error.message}` : undefined;
};
