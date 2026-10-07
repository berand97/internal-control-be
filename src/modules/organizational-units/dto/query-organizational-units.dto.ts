import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class QueryOrganizationalUnitsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  })
  @IsBoolean()
  readonly isActive?: boolean;
}

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return value;
};

export class IncludeArchivedQueryDto {
  @ApiPropertyOptional({ default: false, description: 'true: incluye las archivadas (inactivas); por defecto solo activas' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  readonly includeArchived?: boolean;
}
