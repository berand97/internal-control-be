import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateOrganizationalUnitDto {
  @ApiProperty({ example: 'DCI', maxLength: 20 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'El código debe ser SCREAMING_SNAKE_CASE',
  })
  readonly code!: string;

  @ApiProperty({ example: 'Departamento de Control Interno', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly name!: string;

  @ApiProperty({ enum: ORG_UNIT_TYPES, example: OrgUnitType.Department })
  @IsIn(ORG_UNIT_TYPES)
  readonly type!: OrgUnitType;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Unidad padre. Omitir o null para crear en la raíz.',
  })
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
