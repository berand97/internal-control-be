import { ApiProperty } from '@nestjs/swagger';

export const TIMELINE_EVENT_KINDS = ['ASSET', 'MOVEMENT', 'DOCUMENT', 'PHOTO', 'INVENTORY', 'LOAN'] as const;
export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number];

export const TIMELINE_DATE_PRECISIONS = ['INSTANT', 'DAY', 'UNKNOWN'] as const;
export type TimelineDatePrecision = (typeof TIMELINE_DATE_PRECISIONS)[number];

export class TimelineActorDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ nullable: true })
  readonly name!: string | null;
}

export class TimelineDocumentDto {
  @ApiProperty({ format: 'uuid', description: 'Descargable en GET /documents/:id/pdf' })
  readonly id!: string;

  @ApiProperty({ example: 'OCI-01-55' })
  readonly formatKey!: string;

  @ApiProperty({ example: '0093' })
  readonly number!: string;

  @ApiProperty({ enum: ['PENDING_SIGNATURE', 'SIGNED', 'REJECTED'] })
  readonly status!: string;
}

export class AssetTimelineEventDto {
  @ApiProperty({ example: 'movement:6f1c…', description: 'Estable: tipo de fuente y su id' })
  readonly id!: string;

  @ApiProperty({
    enum: TIMELINE_EVENT_KINDS,
    description: 'Fuente del evento. LOAN está reservado para cuando los préstamos entren al historial.',
  })
  readonly kind!: TimelineEventKind;

  @ApiProperty({
    example: 'REGISTRATION',
    description: 'Subtipo según la fuente: tipo de movimiento, clave de formato SGC, resultado de toma física, etc.',
  })
  readonly type!: string;

  @ApiProperty({ format: 'date-time' })
  readonly occurredAt!: string;

  @ApiProperty({
    enum: TIMELINE_DATE_PRECISIONS,
    description: 'DAY: solo la fecha es cierta. UNKNOWN: no se conoce la fecha real; occurredAt es la de registro.',
  })
  readonly datePrecision!: TimelineDatePrecision;

  @ApiProperty({ type: TimelineActorDto, nullable: true })
  readonly actor!: TimelineActorDto | null;

  @ApiProperty({ example: 'Registro por importación del inventario en Excel' })
  readonly summary!: string;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'Documento generado del evento, si existe' })
  readonly documentId!: string | null;

  @ApiProperty({ type: TimelineDocumentDto, nullable: true })
  readonly document!: TimelineDocumentDto | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  readonly details!: Record<string, unknown>;
}

export class AssetTimelineResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly assetId!: string;

  @ApiProperty({ type: [AssetTimelineEventDto] })
  readonly items!: ReadonlyArray<AssetTimelineEventDto>;

  @ApiProperty()
  readonly page!: number;

  @ApiProperty()
  readonly pageSize!: number;

  @ApiProperty()
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}
