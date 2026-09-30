import { ApiSignerSubstitutions, type SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PHYSICAL_CONDITIONS, PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { SURPLUS_RESOLUTIONS, type SurplusResolution } from '../entities/physical-inventory-item.entity.js';

/** Entradas del corte contable, su asociación a una toma y la resolución de sobrantes. */

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateAccountingCutDto {
  @ApiProperty({ example: '2026-06-30', description: 'Fecha del corte contable (YYYY-MM-DD)' })
  @IsDateString({ strict: true })
  readonly cutDate!: string;

  @ApiProperty({ minLength: 3, maxLength: 200, example: 'Reporte de activos de Contabilidad, junio 2026' })
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(200)
  readonly sourceLabel!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly notes?: string;
}

export class SetInventoryAccountingCutDto {
  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Corte contable a asociar; null lo desasocia (la toma se compara contra la foto del sistema)',
  })
  @IsOptional()
  @IsUUID('4')
  readonly accountingCutId!: string | null;
}

export class SurplusAssetDto {
  @ApiProperty({ maxLength: 500, example: 'Silla ergonómica gris' })
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(500)
  readonly description!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly categoryId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly acquisitionTypeId!: string;

  @ApiProperty({
    example: '2024-02-10',
    description: 'Obligatoria: el activo no se registra sin fecha de adquisición (la del código interno)',
  })
  @IsDateString()
  readonly acquisitionDate!: string;

  @ApiPropertyOptional({ example: 350000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  readonly acquisitionPrice?: number;

  @ApiPropertyOptional({ enum: PHYSICAL_CONDITIONS, enumName: 'PhysicalCondition', description: 'Por defecto, la observada en la toma' })
  @IsOptional()
  @IsIn(PHYSICAL_CONDITIONS)
  readonly physicalCondition?: PhysicalCondition;

  @ApiPropertyOptional({ format: 'uuid', description: 'Por defecto, la ubicación donde se encontró' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly serialNumber?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  readonly model?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly acquisitionDocument?: string;

  @ApiPropertyOptional({ description: 'URL de la foto principal (obligatoria si la categoría la exige)' })
  @IsOptional()
  @IsString()
  readonly photoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class ResolveSurplusDto {
  @ApiProperty({ enum: SURPLUS_RESOLUTIONS, enumName: 'SurplusResolution' })
  @IsIn(SURPLUS_RESOLUTIONS)
  readonly action!: SurplusResolution;

  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Silla sin placa encontrada en la oficina 204' })
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(500)
  readonly reason!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Centro de costo del sobrante en tomas cuyo alcance no es un centro de costo: el del activo (CREATE_ASSET) o el del acta ' +
      'que lo lista sin resolver (LEAVE_UNRESOLVED). Obligatorio ahí salvo que ya se haya elegido con PUT …/surplus-center ' +
      '(entonces se usa ese). En alcance COST_CENTER es el centro de la toma y este campo, si viene, debe ser ese mismo centro.',
  })
  @IsOptional()
  @IsUUID('4')
  readonly costCenterId?: string;

  @ApiPropertyOptional({ type: () => SurplusAssetDto, description: 'Obligatorio con CREATE_ASSET' })
  @ValidateIf((dto: ResolveSurplusDto) => dto.action === 'CREATE_ASSET' || dto.asset !== undefined)
  @ValidateNested()
  @Type(() => SurplusAssetDto)
  readonly asset?: SurplusAssetDto;
}

export class SetSurplusCenterDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Centro de costo activo que admite activos: el sobrante pasa a su acta OCI-21-37',
  })
  @IsUUID('4')
  readonly costCenterId!: string;
}

/** POST /inventories/:id/act/enqueue: cuerpo opcional. */
export class EnqueueInventoryActDto {
  @ApiSignerSubstitutions()
  readonly signerSubstitutions?: SignerSubstitutionsInput;
}
