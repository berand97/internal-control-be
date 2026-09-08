import { ApiProperty } from '@nestjs/swagger';

export class TokenScopeResponseDto {
  @ApiProperty({
    description: 'Tipo de ámbito del rol asignado',
    enum: ['GLOBAL', 'ORG_UNIT', 'COST_CENTER'],
    example: 'ORG_UNIT',
  })
  readonly type!: string;

  @ApiProperty({
    description:
      'Identificador del recurso de ámbito; null cuando el ámbito es GLOBAL',
    format: 'uuid',
    nullable: true,
  })
  readonly id!: string | null;
}
