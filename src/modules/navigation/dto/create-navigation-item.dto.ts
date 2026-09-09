import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateNavigationItemDto {
  @ApiProperty({ example: 'ASSET', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly module!: string;

  @ApiProperty({ example: 'Activos', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  readonly moduleLabel!: string;

  @ApiProperty({ example: 'asset', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'resource debe ser snake_case en minúsculas',
  })
  readonly resource!: string;

  @ApiProperty({ example: '/assets', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^\/[a-z0-9\-_/]*$/, {
    message: 'path debe empezar con / y usar kebab-case',
  })
  readonly path!: string;

  @ApiProperty({ example: 'Activos', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  readonly label!: string;

  @ApiProperty({ example: 'read', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  readonly requiredAction!: string;

  @ApiPropertyOptional({ example: 70, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
