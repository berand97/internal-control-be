import { ApiProperty } from '@nestjs/swagger';

/** Respuestas de la importación del organigrama por Excel (OrgChartService). Cambiar un shape exige cambiar ambos. */

export const ORG_CHART_UNIT_CHANGE_KINDS = [
  'CREATED',
  'RENAMED',
  'MOVED',
  'RETYPED',
  'PREFIX_CHANGED',
  'RELATION_CHANGED',
  'HEAD_CHANGED',
  'COLOR_CHANGED',
  'REACTIVATED',
  'ARCHIVED',
  'DELETED',
] as const;

export const ORG_CHART_CENTER_CHANGE_KINDS = [
  'CREATED',
  'RENAMED',
  'RECODED',
  'RELOCATED',
  'MOVEMENT_CHANGED',
  'REACTIVATED',
  'ARCHIVED',
  'DELETED',
] as const;

export class OrgChartUnitCountsDto {
  @ApiProperty({ description: 'Unidades nuevas' })
  readonly created!: number;
  @ApiProperty({ description: 'Unidades renombradas' })
  readonly renamed!: number;
  @ApiProperty({ description: 'Unidades que cambian de padre' })
  readonly moved!: number;
  @ApiProperty({ description: 'Unidades que cambian de tipo' })
  readonly retyped!: number;
  @ApiProperty({ description: 'Unidades que cambian de prefijo' })
  readonly prefixChanged!: number;
  @ApiProperty({ description: 'Unidades que cambian de línea' })
  readonly relationChanged!: number;
  @ApiProperty({ description: 'Unidades que cambian de centro propio' })
  readonly headChanged!: number;
  @ApiProperty({ description: 'Unidades que cambian o pierden su color base (columna Color)' })
  readonly colorChanged!: number;
  @ApiProperty({ description: 'Unidades reactivadas' })
  readonly reactivated!: number;
  @ApiProperty({ description: 'Unidades a archivar (incluye las marcadas ELIMINAR que tienen historia)' })
  readonly archived!: number;
  @ApiProperty({ description: 'Unidades a eliminar físicamente' })
  readonly deleted!: number;
}

export class OrgChartCenterCountsDto {
  @ApiProperty({ description: 'Centros nuevos' })
  readonly created!: number;
  @ApiProperty({ description: 'Centros renombrados' })
  readonly renamed!: number;
  @ApiProperty({ description: 'Centros recodificados (Código anterior → Código)' })
  readonly recoded!: number;
  @ApiProperty({ description: 'Centros que cambian de unidad o de centro padre' })
  readonly relocated!: number;
  @ApiProperty({ description: 'Centros que cambian de movimiento' })
  readonly movementChanged!: number;
  @ApiProperty({ description: 'Centros reactivados' })
  readonly reactivated!: number;
  @ApiProperty({ description: 'Centros a archivar (incluye los marcados ELIMINAR que tienen historia)' })
  readonly archived!: number;
  @ApiProperty({ description: 'Centros a eliminar físicamente' })
  readonly deleted!: number;
}

export class OrgChartSummaryDto {
  @ApiProperty({ type: OrgChartUnitCountsDto })
  readonly units!: OrgChartUnitCountsDto;

  @ApiProperty({ type: OrgChartCenterCountsDto, description: 'Siempre en 0: el Excel del organigrama no toca centros de costo' })
  readonly centers!: OrgChartCenterCountsDto;

  @ApiProperty({ description: 'Filas que cambian algo (0: el archivo coincide con el sistema)' })
  readonly totalChanges!: number;
}

export class OrgChartIssueDto {
  @ApiProperty({ description: 'Hoja: Organigrama (o Centros de costo en la advertencia de una hoja vieja ignorada)' })
  readonly sheet!: string;

  @ApiProperty({ description: 'Fila del Excel (la 1 es el encabezado)' })
  readonly rowNumber!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Encabezado de la columna' })
  readonly column!: string | null;

  @ApiProperty({ description: 'Mensaje en español' })
  readonly message!: string;
}

export class OrgChartChangeDto {
  @ApiProperty()
  readonly sheet!: string;

  @ApiProperty()
  readonly rowNumber!: number;

  @ApiProperty({ enum: ['ORG_UNIT', 'COST_CENTER'], enumName: 'OrgChartChangeEntity' })
  readonly entity!: 'ORG_UNIT' | 'COST_CENTER';

  @ApiProperty({
    enum: [...new Set([...ORG_CHART_UNIT_CHANGE_KINDS, ...ORG_CHART_CENTER_CHANGE_KINDS])],
    enumName: 'OrgChartChangeKind',
    description: 'Primer cambio de la fila; detail los trae todos',
  })
  readonly kind!: string;

  @ApiProperty({ description: 'Prefijo (o código interno) de la unidad; código del centro' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ description: 'Qué cambia, en español' })
  readonly detail!: string;
}

export class OrgChartConflictDto {
  @ApiProperty({ description: 'Fila del Excel' })
  readonly rowNumber!: number;

  @ApiProperty({ description: 'Nombre actual de la unidad' })
  readonly unitName!: string;

  @ApiProperty({ description: 'Encabezado de la columna (Prefijo, Nombre, Tipo, Depende de, Línea, Centro propio, Color, Estado)' })
  readonly column!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Lo que dice el archivo' })
  readonly fileValue!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Lo que hay hoy en el sistema (como se exportaría)' })
  readonly currentValue!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Cuándo cambió en el sistema (último cambio de ese campo en el historial); null si no se registró',
  })
  readonly changedAt!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien lo cambió' })
  readonly changedBy!: string | null;
}

export class OrgChartAppliedBeforeDto {
  @ApiProperty({ format: 'date-time', description: 'Cuándo se confirmó un archivo idéntico' })
  readonly at!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien lo confirmó' })
  readonly by!: string | null;
}

export class OrgChartPreviewDto {
  @ApiProperty({ format: 'uuid', description: 'Para POST /organizational-units/import/{previewId}/confirm' })
  readonly previewId!: string;

  @ApiProperty()
  readonly fileName!: string;

  @ApiProperty({ format: 'date-time', description: 'Después de esta hora hay que volver a previsualizar' })
  readonly expiresAt!: string;

  @ApiProperty({ description: 'false si hay errores (las advertencias no bloquean) o no hay cambios' })
  readonly canConfirm!: boolean;

  @ApiProperty({ description: 'Siempre false: el Excel del organigrama no toca centros de costo (se conserva por compatibilidad)' })
  readonly requiresCostCenterPermission!: boolean;

  @ApiProperty({ type: OrgChartSummaryDto })
  readonly summary!: OrgChartSummaryDto;

  @ApiProperty({ type: [OrgChartChangeDto] })
  readonly changes!: ReadonlyArray<OrgChartChangeDto>;

  @ApiProperty({ type: [OrgChartIssueDto], description: 'Bloquean la confirmación' })
  readonly errors!: ReadonlyArray<OrgChartIssueDto>;

  @ApiProperty({ type: [OrgChartIssueDto], description: 'No bloquean (p. ej. códigos que no cuadran)' })
  readonly warnings!: ReadonlyArray<OrgChartIssueDto>;

  @ApiProperty({
    type: [OrgChartConflictDto],
    description:
      'Columnas que la persona cambió en su archivo y que otra persona cambió en el sistema después de la descarga (según el sello oculto). Cada una también viene en errors: bloquean; hay que descargar de nuevo',
  })
  readonly conflicts!: ReadonlyArray<OrgChartConflictDto>;

  @ApiProperty({
    type: OrgChartAppliedBeforeDto,
    nullable: true,
    description: 'Un archivo idéntico (mismo contenido) ya se confirmó; null si no',
  })
  readonly fileAppliedBefore!: OrgChartAppliedBeforeDto | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Días desde que se descargó el archivo (según su sello); null si no trae sello. Más de 7 deja una advertencia',
  })
  readonly fileAgeDays!: number | null;
}

export class OrgChartConfirmDto {
  @ApiProperty({ format: 'uuid' })
  readonly previewId!: string;

  @ApiProperty({ format: 'date-time' })
  readonly confirmedAt!: string;

  @ApiProperty({ type: OrgChartSummaryDto, description: 'Lo que se aplicó' })
  readonly summary!: OrgChartSummaryDto;
}
