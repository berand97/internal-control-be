import { ApiProperty } from '@nestjs/swagger';

/**
 * Esquemas de respuesta de /notifications. Solo documentan lo que NotificationsService ya devuelve: cambiar un shape
 * exige cambiar ambos.
 */

export const NOTIFICATION_TYPES = ['IMPORT_FINISHED', 'IMPORT_FAILED'] as const;

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({
    description: `Código del aviso. Hoy: ${NOTIFICATION_TYPES.join(', ')}. Puede crecer: trate uno desconocido como genérico`,
    example: 'IMPORT_FINISHED',
  })
  readonly type!: string;

  @ApiProperty()
  readonly title!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Texto plano; puede tener saltos de línea' })
  readonly body!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Entidad a la que lleva el aviso. IMPORT_*: STAGING_IMPORT_JOB (entityId = jobId de GET /imports/jobs/{jobId})',
  })
  readonly entityType!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly entityId!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'null = no leída' })
  readonly readAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto], description: 'Más recientes primero' })
  readonly items!: NotificationDto[];

  @ApiProperty({ type: 'integer', description: 'Total con el filtro aplicado' })
  readonly total!: number;

  @ApiProperty({ type: 'integer', description: 'No leídas del usuario (sin importar el filtro)' })
  readonly unread!: number;

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;
}

export class NotificationUnreadCountDto {
  @ApiProperty({ type: 'integer' })
  readonly count!: number;
}

export class NotificationsMarkedDto {
  @ApiProperty({ type: 'integer', description: 'Cuántas pasaron de no leídas a leídas' })
  readonly updated!: number;
}
