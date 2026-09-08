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
import { ORG_UNIT_TYPES, OrgUnitType } from '../enums/org-unit-type.enum.js';

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
}
