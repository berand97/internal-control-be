import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { AuditReason } from '../../../common/validation/audit-reason.decorator.js';

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

  @AuditReason('Motivo del otorgamiento.')
  readonly reason!: string;
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

  @AuditReason('Motivo del cambio de permisos (lo agregado y lo quitado).')
  readonly reason!: string;
}

/** Cuerpo de DELETE /roles/:id/permissions/:permissionId: el retiro también exige motivo. */
export class RemovePermissionDto {
  @AuditReason('Motivo del retiro del permiso.')
  readonly reason!: string;
}
