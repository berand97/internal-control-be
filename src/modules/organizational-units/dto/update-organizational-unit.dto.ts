import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  ORG_RELATION_TYPES,
  ORG_UNIT_TYPES,
  OrgRelationType,
  OrgUnitType,
} from '../enums/org-unit-type.enum.js';

export class UpdateOrganizationalUnitDto {
  @ApiPropertyOptional({ example: 'DCI', maxLength: 20 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'El código debe ser SCREAMING_SNAKE_CASE',
  })
  readonly code?: string;

  @ApiPropertyOptional({
    example: 'Departamento de Control Interno',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly name?: string;

  @ApiPropertyOptional({ enum: ORG_UNIT_TYPES, example: OrgUnitType.Department })
  @IsOptional()
  @IsIn(ORG_UNIT_TYPES)
  readonly type?: OrgUnitType;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Nueva dependencia. UUID para mover la unidad (y su subárbol); null para dejarla en la raíz. Omitir para no cambiar el padre.',
  })
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '4',
    maxLength: 4,
    description:
      'Dígito(s) inicial(es) del rango de códigos de sus centros de costo (4 → 4000–4999). Único entre unidades activas. null lo quita; omitir no lo cambia.',
  })
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @Matches(/^[0-9]{1,4}$/, { message: 'El prefijo son de 1 a 4 dígitos' })
  readonly codePrefix?: string | null;

  @ApiPropertyOptional({
    enum: ORG_RELATION_TYPES,
    enumName: 'OrgRelationType',
    description: 'Línea del organigrama hacia su padre (por defecto AUTHORITY)',
  })
  @IsOptional()
  @IsIn(ORG_RELATION_TYPES)
  readonly relationType?: OrgRelationType;

  @ApiPropertyOptional({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Centro de costo «propio» del cuadro (p. ej. 2510 Decanatura para la unidad 25). null lo quita',
  })
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsUUID('4')
  readonly headCostCenterId?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '1510',
    maxLength: 20,
    description:
      'Centro propio por código. Si el centro no existe todavía (o está archivado) se guarda como pendiente con una advertencia y se amarra solo cuando se cree. Tiene prioridad sobre headCostCenterId. null lo quita.',
  })
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @Matches(/^[0-9]{1,20}$/, { message: 'El código del centro propio son solo dígitos' })
  readonly headCostCenterCode?: string | null;
}
