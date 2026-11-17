import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SetLocationCompanionDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Persona del sistema. No junto con name.' })
  @IsOptional()
  @IsUUID()
  @ValidateIf((dto: SetLocationCompanionDto) => !dto.name)
  readonly personId?: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 200, description: 'Nombre libre. No junto con personId.' })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(2)
  @MaxLength(200)
  @ValidateIf((dto: SetLocationCompanionDto) => !dto.personId)
  readonly name?: string;
}

export class LocationCompanionDto {
  @ApiProperty({ format: 'uuid' })
  readonly inventoryId!: string;

  @ApiProperty({ format: 'uuid' })
  readonly locationId!: string;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {
      personId: { type: 'string', format: 'uuid', nullable: true },
      name: { type: 'string' },
      recordedAt: { type: 'string', format: 'date-time' },
      recordedBy: { type: 'string', format: 'uuid' },
    },
  })
  readonly companion!: {
    personId: string | null;
    name: string;
    recordedAt: string;
    recordedBy: string;
  } | null;
}
