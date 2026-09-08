import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ReassignCostCenterDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly costCenterId!: string;

  @ApiProperty({ description: 'Acta u oficio de autorización' })
  @IsString()
  @IsNotEmpty()
  readonly documentReference!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly reason?: string;
}
