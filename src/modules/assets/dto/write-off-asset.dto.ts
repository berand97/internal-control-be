import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class WriteOffAssetDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly reason!: string;

  @ApiProperty({ description: 'Acta, oficio o URL de autorización' })
  @IsString()
  @IsNotEmpty()
  readonly documentReference!: string;

  @ApiPropertyOptional({ example: '2026-11-21' })
  @IsOptional()
  @IsDateString()
  readonly writtenOffAt?: string;
}
