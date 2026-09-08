import { ApiProperty } from '@nestjs/swagger';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Identificador del usuario' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombre de usuario', example: 'juliana.perez' })
  readonly username!: string;

  @ApiProperty({
    description: 'Códigos de roles activos',
    type: [String],
    example: ['INTERNAL_CONTROL_DIRECTOR', 'AUDITOR'],
  })
  readonly roles!: ReadonlyArray<string>;

  @ApiProperty({
    description:
      'Si es true, el frontend debe mostrar el formulario de actualización de contraseña y no continuar al resto de la plataforma',
  })
  readonly mustChangePassword!: boolean;
}
