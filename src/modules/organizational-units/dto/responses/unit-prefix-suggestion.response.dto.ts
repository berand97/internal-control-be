import { ApiProperty } from '@nestjs/swagger';

/** Prefijo sugerido para una unidad nueva (GET /organizational-units/suggest-prefix). */
export class UnitPrefixSuggestionDto {
  @ApiProperty({
    description: 'Parte fija: el prefijo del ancestro más cercano con prefijo ("" si no hay ninguno)',
    example: '4',
  })
  readonly fixedPrefix!: string;

  @ApiProperty({ type: 'string', nullable: true, example: '42', description: 'Siguiente libre (fixedPrefix + 1–9); null si no queda' })
  readonly suggested!: string | null;

  @ApiProperty({ type: [String], example: ['41', '43'], description: 'Prefijos de ese nivel ya usados por unidades activas' })
  readonly taken!: ReadonlyArray<string>;
}
