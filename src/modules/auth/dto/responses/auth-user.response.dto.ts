import { ApiProperty } from '@nestjs/swagger';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Identificador del usuario' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombre de usuario', example: 'juliana.perez' })
  readonly username!: string;

  @ApiProperty({
    type: [String],
    description: 'Códigos de roles activos',
    example: ['INTERNAL_CONTROL_DIRECTOR', 'AUDITOR'],
  })
  readonly roles!: ReadonlyArray<string>;
}
