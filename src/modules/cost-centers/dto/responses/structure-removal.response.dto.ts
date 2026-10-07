import { ApiProperty } from '@nestjs/swagger';

/** Resultado de DELETE de un centro de costo o una unidad: borrado físico o archivado (con el motivo). */
export class StructureRemovalResultDto {
  @ApiProperty({ description: 'true: se borró de verdad (no tenía historia)' })
  readonly deleted!: boolean;

  @ApiProperty({ description: 'true: se archivó (is_active=false) porque tiene historia' })
  readonly archived!: boolean;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Por qué se archivó en vez de borrarse (p. ej. «Se archiva porque tiene historia: 3 movimientos de activos»)',
  })
  readonly reason!: string | null;
}
