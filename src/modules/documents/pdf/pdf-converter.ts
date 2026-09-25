import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';

export const PDF_CONVERTER = 'PdfConverter';

export interface PdfConverter {
  toPdf(docx: Buffer, fileName: string): Promise<Buffer>;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

@Injectable()
export class GotenbergPdfConverter implements PdfConverter {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async toPdf(docx: Buffer, fileName: string): Promise<Buffer> {
    const url = this.config.getOrThrow('documents', { infer: true }).gotenbergUrl;
    if (!url) {
      throw new ApiException(
        ErrorCode.ExternalServiceFailure,
        'La conversión a PDF no está configurada (GOTENBERG_URL)',
      );
    }
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), fileName);
    const response = await fetch(`${url.replace(/\/$/, '')}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      throw new ApiException(
        ErrorCode.ExternalServiceFailure,
        `Gotenberg respondió ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
