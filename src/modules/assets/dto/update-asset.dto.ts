import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateAssetDto } from './create-asset.dto.js';

export class UpdateAssetDto extends PartialType(CreateAssetDto) {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  readonly insurancePolicyNumber?: string;
}
