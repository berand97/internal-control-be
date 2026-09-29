import { ApiProperty } from '@nestjs/swagger';

/** Rol activo del usuario con su nombre para mostrar (el que el administrador edita en Roles). */
export class ActiveRoleResponseDto {
  @ApiProperty({ description: 'Código estable del rol (el mismo de roles[])', example: 'INTERNAL_CONTROL_DIRECTOR' })
  readonly code!: string;

  @ApiProperty({ description: 'Nombre del rol tal como está en la base de datos (editable)', example: 'Director de Control Interno' })
  readonly name!: string;
}
