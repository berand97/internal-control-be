import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, ValidateNested } from 'class-validator';
import { IMPORT_MODES, ImportMode } from '../enums/import-mode.enum.js';
import { CreateAssetDto } from './create-asset.dto.js';

export class BulkCreateAssetsDto {
  @ApiProperty({ type: [CreateAssetDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CreateAssetDto)
  readonly items!: CreateAssetDto[];

  @ApiPropertyOptional({ enum: IMPORT_MODES, default: ImportMode.AllOrNothing })
  @IsOptional()
  @IsIn(IMPORT_MODES)
  readonly mode?: ImportMode;
}
