import {
  type CallHandler,
  type ExecutionContext,
  mixin,
  type NestInterceptor,
  PayloadTooLargeException,
  type Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

const MIB = 1024 * 1024;

export interface UploadLimits {
  readonly maxFileBytes: number;
  readonly maxFields?: number;
}

export const UPLOAD_LIMITS = {
  EXCEL_IMPORT: { maxFileBytes: 25 * MIB },
  ASSET_CSV: { maxFileBytes: 5 * MIB },
  COST_CENTER_CSV: { maxFileBytes: 1 * MIB },
  DOCX_TEMPLATE: { maxFileBytes: 10 * MIB },
  EMAIL_IMAGE: { maxFileBytes: 1 * MIB },
} as const satisfies Record<string, UploadLimits>;

export const BoundedFileInterceptor = (
  fieldName: string,
  limits: UploadLimits,
): Type<NestInterceptor> => {
  const maxFields = limits.maxFields ?? 5;
  const Base = FileInterceptor(fieldName, {
    limits: {
      fileSize: limits.maxFileBytes,
      files: 1,
      fields: maxFields,
      parts: maxFields + 1,
      fieldNameSize: 100,
      fieldSize: 64 * 1024,
      headerPairs: 50,
    },
  });
  const maxMib = Math.round((limits.maxFileBytes / MIB) * 10) / 10;

  class BoundedInterceptor implements NestInterceptor {
    private readonly inner = new Base({});

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      try {
        return await this.inner.intercept(context, next);
      } catch (error) {
        if (error instanceof PayloadTooLargeException) {
          throw new ApiException(
            ErrorCode.FileTooLarge,
            `El archivo supera el máximo de ${maxMib} MB`,
          );
        }
        throw error;
      }
    }
  }
  return mixin(BoundedInterceptor);
};
