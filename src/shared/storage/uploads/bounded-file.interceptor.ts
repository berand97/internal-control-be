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
  /** Tamaño máximo del archivo, en bytes. */
  readonly maxFileBytes: number;
  /** Campos de texto que acompañan al archivo en el multipart (por defecto 5). */
  readonly maxFields?: number;
}

/**
 * Límites por endpoint (BE-05). Cada valor sale del archivo real que recibe, con margen:
 * - EXCEL_IMPORT: el informe mensual de activos pesa 3,1 MiB (7.1 informe control activos julio 2026.xlsx); 25 MiB ≈ 8x.
 * - ASSET_CSV: la previsualización admite 5.000 filas (MAX_IMPORT_ROWS); 5 MiB ≈ 1 KiB por fila.
 * - COST_CENTER_CSV: 4 columnas y ~250 centros de costo; 1 MiB admite más de 10.000 filas.
 * - DOCX_TEMPLATE: las plantillas reales pesan 3–52 KiB; 10 MiB es el tope que ya aplicaba el servicio
 *   (document-templates.service MAX_BYTES) y la subida de formatos, ahora antes de bufferizar.
 */
export const UPLOAD_LIMITS = {
  EXCEL_IMPORT: { maxFileBytes: 25 * MIB },
  ASSET_CSV: { maxFileBytes: 5 * MIB },
  COST_CENTER_CSV: { maxFileBytes: 1 * MIB },
  DOCX_TEMPLATE: { maxFileBytes: 10 * MIB },
} as const satisfies Record<string, UploadLimits>;

/**
 * FileInterceptor de un solo archivo con todos los límites de multer declarados: tamaño, un único archivo,
 * número y tamaño de campos, partes y cabeceras. Superar el tamaño responde 400 FILE_TOO_LARGE con el máximo;
 * los demás límites de multer ya responden 400 MALFORMED_REQUEST.
 */
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

  // Composición y no herencia: la clase de FileInterceptor inyecta MULTER_MODULE_OPTIONS como opcional y Nest no
  // hereda esa marca a una subclase. La app no registra MulterModule, así que las opciones globales son {}.
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
