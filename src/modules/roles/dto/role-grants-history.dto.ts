import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Tipos de otorgamiento/retiro que muestra el historial (acción de bitácora → nombre de contrato). */
export const ROLE_GRANT_EVENTS = [
  'ROLE_CREATED',
  'ROLE_UPDATED',
  'ROLE_DELETED',
  'ROLE_PERMISSIONS_CHANGED',
  'USER_CREATED_WITH_ROLE',
  'USER_ROLE_GRANTED',
  'USER_ROLE_REVOKED',
  'USER_ROLE_DELEGATED',
] as const;
export type RoleGrantEvent = (typeof ROLE_GRANT_EVENTS)[number];

export class QueryRoleGrantsHistoryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ format: 'uuid', description: 'Rol afectado (sus permisos, su edición o su asignación a usuarios)' })
  @IsOptional()
  @IsUUID()
  readonly roleId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Permiso agregado o quitado' })
  @IsOptional()
  @IsUUID()
  readonly permissionId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Usuario que recibió o perdió un rol' })
  @IsOptional()
  @IsUUID()
  readonly userId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Usuario que hizo el cambio' })
  @IsOptional()
  @IsUUID()
  readonly performedBy?: string;

  @ApiPropertyOptional({ enum: ROLE_GRANT_EVENTS, enumName: 'RoleGrantEvent' })
  @IsOptional()
  @IsIn(ROLE_GRANT_EVENTS)
  readonly event?: RoleGrantEvent;

  @ApiPropertyOptional({ format: 'date-time', description: 'Desde (incluido), ISO 8601' })
  @IsOptional()
  @IsDateString()
  readonly from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Hasta (excluido), ISO 8601' })
  @IsOptional()
  @IsDateString()
  readonly to?: string;
}

export class RoleGrantActorDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombres y apellidos de la persona del usuario; si no tiene persona, su usuario' })
  readonly name!: string;
}

export class RoleGrantRoleDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'null si el rol ya no existe en la BD' })
  readonly code!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;
}

export class RoleGrantPermissionDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Código del permiso (null si se borró y no quedó registrado)' })
  readonly code!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Nombre legible en español, del catálogo de permisos (su descripción o, si no tiene, el nombre del recurso); null si el permiso ya no existe',
    example: 'Ver historial de permisos otorgados',
  })
  readonly label!: string | null;
}

export class RoleGrantHistoryItemDto {
  @ApiProperty({ description: 'Id de la entrada de bitácora' })
  readonly id!: string;

  @ApiProperty({ format: 'date-time' })
  readonly performedAt!: string;

  @ApiProperty({ enum: ROLE_GRANT_EVENTS, enumName: 'RoleGrantEvent' })
  readonly event!: RoleGrantEvent;

  @ApiProperty({ type: RoleGrantActorDto, nullable: true, description: 'Quién lo hizo' })
  readonly performedBy!: RoleGrantActorDto | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'IP del request (null en registros anteriores a este cambio)' })
  readonly ipAddress!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly userAgent!: string | null;

  @ApiProperty({ type: RoleGrantRoleDto, nullable: true, description: 'Rol afectado' })
  readonly role!: RoleGrantRoleDto | null;

  @ApiProperty({ type: RoleGrantActorDto, nullable: true, description: 'Usuario que recibió o perdió el rol (eventos USER_*)' })
  readonly targetUser!: RoleGrantActorDto | null;

  @ApiProperty({ type: [RoleGrantPermissionDto] })
  readonly addedPermissions!: RoleGrantPermissionDto[];

  @ApiProperty({ type: [RoleGrantPermissionDto] })
  readonly removedPermissions!: RoleGrantPermissionDto[];

  @ApiProperty({
    type: 'string',
    nullable: true,
    enum: ['GLOBAL', 'ORG_UNIT', 'COST_CENTER'],
    enumName: 'RoleGrantScopeType',
    description: 'Alcance de la asignación (eventos USER_*)',
  })
  readonly scopeType!: 'GLOBAL' | 'ORG_UNIT' | 'COST_CENTER' | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly scopeId!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Vigencia de la asignación' })
  readonly validFrom!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly validUntil!: string | null;

  @ApiProperty({ type: [String], description: 'ROLE_UPDATED: campos del rol que cambiaron (name, description, parentRoleId, superiorRoleId)' })
  readonly changedFields!: string[];

  @ApiProperty({ type: 'string', nullable: true, description: 'Motivo (null en registros anteriores a que fuera obligatorio)' })
  readonly reason!: string | null;
}

export class RoleGrantPaginationDto {
  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly totalItems!: number;

  @ApiProperty({ type: 'integer' })
  readonly totalPages!: number;
}

export class RoleGrantsHistoryPageDto {
  @ApiProperty({ type: [RoleGrantHistoryItemDto] })
  readonly items!: RoleGrantHistoryItemDto[];

  @ApiProperty({ type: RoleGrantPaginationDto })
  readonly pagination!: RoleGrantPaginationDto;
}
