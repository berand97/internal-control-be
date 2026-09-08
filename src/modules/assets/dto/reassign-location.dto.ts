import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class ReassignLocationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly locationId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly reason?: string;
}
