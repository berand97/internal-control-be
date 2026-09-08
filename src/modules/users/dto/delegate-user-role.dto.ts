import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

export class DelegateUserRoleDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Usuario que recibe la delegación',
  })
  @IsUUID('4')
  readonly toUserId!: string;

  @ApiProperty({
    description: 'Vencimiento obligatorio de la delegación (ISO 8601)',
  })
  @IsDateString()
  readonly validUntil!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly reason?: string;
}
