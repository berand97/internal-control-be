import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PermissionScopeLevel } from '../enums/permission-scope-level.enum.js';

const ACTIONS = [
  'read',
  'manage',
  'create',
  'update',
  'delete',
  'assign',
  'approve',
  'export',
  'sign',
] as const;

export class CreatePermissionDto {
  @ApiProperty({ example: 'ASSET', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly module!: string;

  @ApiProperty({ example: 'asset', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/)
  readonly resourceType!: string;

  @ApiProperty({ example: 'read', enum: ACTIONS })
  @IsIn(ACTIONS)
  readonly action!: (typeof ACTIONS)[number];

  @ApiProperty({ enum: PermissionScopeLevel, example: PermissionScopeLevel.Global })
  @IsIn(Object.values(PermissionScopeLevel))
  readonly scopeLevel!: PermissionScopeLevel;

  @ApiPropertyOptional({ example: 'Activos', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  readonly resourceLabel?: string;

  @ApiPropertyOptional({ example: 'Consultar activos' })
  @IsOptional()
  @IsString()
  readonly description?: string;
}

export class UpdatePermissionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly description?: string;
}
