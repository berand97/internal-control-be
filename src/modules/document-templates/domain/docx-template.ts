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
      paragraphLoop: true,
      linebreaks: true,
    });
    document.render(nestContext(context));
    return Buffer.from(document.getZip().generate({ type: 'nodebuffer' }));
  } catch {
    throw new ApiException(ErrorCode.TemplateInvalidDocx);
  }
};
