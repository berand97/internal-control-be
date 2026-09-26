import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class QueryPersonDirectoryDto {
  @ApiPropertyOptional({ description: 'Parte del nombre completo o prefijo del número de documento' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly search?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  readonly pageSize: number = 20;
}

export class PersonDirectoryItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombres y apellidos' })
  readonly name!: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Código del catálogo GET /persons/document-types; null si se desconoce (persona importada sin tipo)',
  })
  readonly documentType!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Cargo' })
  readonly positionTitle!: string | null;

  @ApiProperty()
  readonly email!: string;

  @ApiProperty({ description: 'Tiene un usuario del sistema en estado ACTIVE' })
  readonly hasActiveUser!: boolean;

  @ApiProperty({
    description:
      'Su usuario activo tiene MFA. Firmar un acta exige usuario activo con MFA: sin esto la persona puede quedar asignada a un turno, pero no firmarlo',
  })
  readonly mfaEnabled!: boolean;
}

export class PersonDirectoryResponseDto {
  @ApiProperty({ type: [PersonDirectoryItemDto] })
  readonly items!: PersonDirectoryItemDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}
