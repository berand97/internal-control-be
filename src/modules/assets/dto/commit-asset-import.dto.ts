import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { IMPORT_MODES, ImportMode } from '../enums/import-mode.enum.js';

export class CommitAssetImportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly previewId!: string;

  @ApiPropertyOptional({ enum: IMPORT_MODES, default: ImportMode.AllOrNothing })
  @IsOptional()
  @IsIn(IMPORT_MODES)
  readonly mode?: ImportMode;
}
