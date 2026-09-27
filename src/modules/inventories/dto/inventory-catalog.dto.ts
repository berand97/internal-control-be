import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PHYSICAL_CONDITIONS } from '../../assets/enums/physical-condition.enum.js';

/** Resultados que una categoría de hallazgo puede sugerir (los mismos del CHECK de la migración 1767225870000). */
export const SUGGESTIBLE_RESULTS = ['FOUND', 'MISSING', 'MISPLACED', 'SURPLUS'] as const;
export type SuggestibleResult = (typeof SUGGESTIBLE_RESULTS)[number];

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class CreateFindingCategoryDto {
  @ApiProperty({ pattern: '^[A-Z0-9_]{1,10}$', example: 'AOB', description: 'Inmutable; se guarda en mayúsculas' })
  @IsString()
  @Transform(upper)
  @Matches(/^[A-Z0-9_]{1,10}$/)
  readonly code!: string;

  @ApiProperty({ minLength: 2, maxLength: 80 })
  @IsString()
  @Transform(trimmed)
  @MinLength(2)
  @MaxLength(80)
  readonly label!: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MaxLength(500)
  readonly description?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 9999, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  readonly sortOrder?: number;

  @ApiPropertyOptional({
    type: 'array',
    nullable: true,
    items: { type: 'string', enum: [...SUGGESTIBLE_RESULTS] },
    description: 'Se sugiere cuando el resultado del ítem está en la lista; null = no mira el resultado',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SUGGESTIBLE_RESULTS, { each: true })
  readonly suggestResults?: SuggestibleResult[] | null;

  @ApiPropertyOptional({
    type: 'array',
    nullable: true,
    items: { type: 'string', enum: [...PHYSICAL_CONDITIONS] },
    description:
      'Se sugiere cuando la condición observada está en la lista (pesa más que el resultado); null = no mira la condición',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PHYSICAL_CONDITIONS, { each: true })
  readonly suggestConditions?: string[] | null;

  @ApiPropertyOptional({
    default: false,
    description: 'true = nadie ha definido qué significa: no se sugiere ni se puede asignar a un ítem',
  })
  @IsOptional()
  @IsBoolean()
  readonly pendingDefinition?: boolean;
}

export class UpdateFindingCategoryDto extends PartialType(OmitType(CreateFindingCategoryDto, ['code'] as const)) {}

export class CreateMissingCauseDto {
  @ApiProperty({ minLength: 3, maxLength: 120, example: 'Hurto con denuncia' })
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(120)
  readonly label!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 9999, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  readonly sortOrder?: number;
}

export class UpdateMissingCauseDto extends PartialType(CreateMissingCauseDto) {}
