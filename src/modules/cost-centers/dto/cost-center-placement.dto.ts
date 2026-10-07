import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);

export class ChangeCostCenterPlacementDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Nueva unidad; null la quita; omitir no la cambia',
  })
  @Transform(emptyToNull)
  @IsOptional()
  @IsUUID('4')
  readonly organizationalUnitId?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Nuevo centro padre; null lo deja en la raíz; omitir no lo cambia',
  })
  @Transform(emptyToNull)
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string | null;

  @ApiPropertyOptional({
    description:
      'false: nodo agrupador (también deja de aceptar activos; se rechaza si tiene activos); true: recibe movimientos. Omitir no lo cambia',
  })
  @IsOptional()
  @IsBoolean()
  readonly hasMovement?: boolean;

  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Motivo o soporte del cambio (queda en el historial)' })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @Length(3, 500)
  readonly reason!: string;
}

export class CostCenterAtQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-28',
    description: 'Fecha (AAAA-MM-DD): se resuelve al final de ese día, hora de Colombia. Por defecto, ahora',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'at debe tener la forma AAAA-MM-DD' })
  readonly at?: string;
}

export class SuggestCostCenterCodeQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Unidad (su prefijo define el rango)' })
  @IsOptional()
  @IsUUID('4')
  readonly unitId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Centro padre: se sugiere el siguiente código libre bajo él' })
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string;
}

export class CostCenterTreeQueryDto extends CostCenterAtQueryDto {
  @ApiPropertyOptional({ default: false, description: 'true: incluye los archivados (inactivos); por defecto solo activos' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  readonly includeArchived?: boolean;
}
