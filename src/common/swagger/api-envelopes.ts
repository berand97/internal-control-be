import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';
import {
  ERROR_ACTIONS,
  SUCCESS_ACTIONS,
} from '../types/response-envelope.type.js';

export class ApiSuccessEnvelope {
  @ApiProperty({ description: 'Payload real de la respuesta' })
  readonly data!: unknown;

  @ApiProperty({ enum: ['SUCCESS'], description: 'Tipo de envelope' })
  readonly type!: 'SUCCESS';

  @ApiProperty({ enum: SUCCESS_ACTIONS, description: 'Hint para el cliente' })
  readonly action!: (typeof SUCCESS_ACTIONS)[number];
}

export class ApiErrorEnvelope {
  @ApiProperty({
    description:
      'Cuerpo del error: message legible, code del catálogo y details opcionales',
    example: { message: 'La sesión expiró', code: 'TOKEN_EXPIRED' },
  })
  readonly error!: unknown;

  @ApiProperty({ enum: ['ERROR'], description: 'Tipo de envelope' })
  readonly type!: 'ERROR';

  @ApiProperty({ enum: ERROR_ACTIONS, description: 'Hint de manejo esperado' })
  readonly action!: (typeof ERROR_ACTIONS)[number];
}

export const envelopedSchema = (dto: Function): SchemaObject => ({
  allOf: [
    { $ref: getSchemaPath(ApiSuccessEnvelope) },
    { properties: { data: { $ref: getSchemaPath(dto) } } },
  ],
});

export const envelopedOneOfSchema = (
  ...dtos: ReadonlyArray<Function>
): SchemaObject => ({
  allOf: [
    { $ref: getSchemaPath(ApiSuccessEnvelope) },
    {
      properties: {
        data: { oneOf: dtos.map((dto) => ({ $ref: getSchemaPath(dto) })) },
      },
    },
  ],
});

export const errorEnvelopeSchema = (): ReferenceObject => ({
  $ref: getSchemaPath(ApiErrorEnvelope),
});
