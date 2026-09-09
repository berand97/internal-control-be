import { ApiProperty } from '@nestjs/swagger';

export class AffiliationOrgUnitOptionDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty()
  readonly type!: string;
}

export class AffiliationCostCenterOptionDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly externalCode!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly organizationalUnitId!: string | null;
}

export class AffiliationRoleOptionDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class UserAffiliationOptionsResponseDto {
  @ApiProperty({ type: [AffiliationOrgUnitOptionDto] })
  readonly organizationalUnits!: ReadonlyArray<AffiliationOrgUnitOptionDto>;

  @ApiProperty({ type: [AffiliationCostCenterOptionDto] })
  readonly costCenters!: ReadonlyArray<AffiliationCostCenterOptionDto>;

  @ApiProperty({ type: [AffiliationRoleOptionDto] })
  readonly roles!: ReadonlyArray<AffiliationRoleOptionDto>;
}
