import { ApiProperty } from '@nestjs/swagger';
import {
  ORG_HISTORY_FIELDS,
  ORG_HISTORY_SOURCES,
  type OrgHistoryField,
  type OrgHistorySource,
} from '../../../cost-centers/services/org-structure-history.service.js';

/** Evento del historial de nombre/código/tipo/padre/prefijo/línea/centro propio/estado (OrgStructureHistoryService). */
export class OrgStructureHistoryEventDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({
    enum: ORG_HISTORY_FIELDS,
    enumName: 'OrgStructureHistoryField',
    description: 'Campo que cambió. TYPE y RELATION traen los códigos del enum; STATUS: ACTIVE/ARCHIVED',
  })
  readonly field!: OrgHistoryField;

  @ApiProperty({ type: 'string', nullable: true })
  readonly oldValue!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly newValue!: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly changedAt!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly changedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien hizo el cambio' })
  readonly changedByName!: string | null;

  @ApiProperty({ enum: ORG_HISTORY_SOURCES, enumName: 'OrgStructureHistorySource' })
  readonly source!: OrgHistorySource;

  @ApiProperty({ type: 'string', nullable: true })
  readonly reason!: string | null;
}
