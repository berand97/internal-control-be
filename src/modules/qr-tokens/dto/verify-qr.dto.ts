import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class VerifyQrQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly token?: string;

  @ApiPropertyOptional({ enum: ['json', 'png'], default: 'json' })
  @IsOptional()
  @IsIn(['json', 'png'])
  readonly format?: 'json' | 'png';

  @ApiPropertyOptional({ default: 300 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(800)
  readonly size?: number;
}

export class VerifyQrBodyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly token!: string;
}
