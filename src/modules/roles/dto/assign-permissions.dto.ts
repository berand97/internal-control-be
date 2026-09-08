import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class AssignPermissionsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Permisos a agregar al rol (no quita los existentes)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  readonly permissionIds!: ReadonlyArray<string>;
}

export class ReplacePermissionsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Set completo de permisos del rol. Reemplaza el existente; [] deja el rol sin permisos directos.',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  readonly permissionIds!: ReadonlyArray<string>;
}
