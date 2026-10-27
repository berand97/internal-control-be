import { ApiProperty } from '@nestjs/swagger';

export class UnitCostCenterHeadDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty({ description: 'Nombre completo del jefe vigente' })
  readonly fullName!: string;
}

export class UnitCostCenterDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código visible del centro de costo (por ejemplo 2510)' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty()
  readonly acceptsAssets!: boolean;

  @ApiProperty({
    type: UnitCostCenterHeadDto,
    nullable: true,
    description: 'Jefe vigente hoy (el mismo criterio con el que se exige jefe para recibir activos); null si no tiene',
  })
  readonly currentHead!: UnitCostCenterHeadDto | null;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Activos cuyo centro actual es este, sin contar los dados de baja' })
  readonly assetCount!: number;
}
