import { ApiProperty } from '@nestjs/swagger';
import { ActiveRoleResponseDto } from './active-role.response.dto.js';

export class AuthUserResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Identificador del usuario' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombre de usuario', example: 'juliana.perez' })
  readonly username!: string;

  @ApiProperty({
    description: 'Códigos de roles activos (texto libre: el SUPER_ADMIN crea roles nuevos). Solo informativo; la UI no debe ramificar por rol.',
    type: [String],
    example: ['INTERNAL_CONTROL_DIRECTOR', 'AUDITOR'],
  })
  readonly roles!: ReadonlyArray<string>;

  @ApiProperty({
    description: 'Los mismos roles activos que roles[], con el nombre editable del rol para mostrarlo. Solo informativo.',
    type: [ActiveRoleResponseDto],
  })
  readonly roleDetails!: ReadonlyArray<ActiveRoleResponseDto>;

  @ApiProperty({
    description:
      'Si es true, el frontend debe mostrar el formulario de actualización de contraseña y no continuar al resto de la plataforma',
  })
  readonly mustChangePassword!: boolean;
}
