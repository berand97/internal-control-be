import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { AGREEMENT_STATUSES, type AgreementStatus } from '../entities/physical-inventory-act-agreement.entity.js';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RespondAgreementDto {
  @ApiProperty({ enum: ['AGREED', 'OBJECTED'] })
  @IsIn(['AGREED', 'OBJECTED'])
  readonly decision!: 'AGREED' | 'OBJECTED';

  @ApiPropertyOptional({ minLength: 3, maxLength: 1000, description: 'Obligatorio si OBJECTED.' })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(1000)
  @ValidateIf((dto: RespondAgreementDto) => dto.decision === 'OBJECTED')
  readonly comment?: string;
}

export class IssueObjectedActDto {
  @ApiProperty({ description: 'Emitir el acta pese a objeción del jefe.' })
  @IsBoolean()
  readonly allowObjected!: boolean;

  @ApiProperty({ minLength: 20, maxLength: 1000 })
  @IsString()
  @Transform(trimmed)
  @MinLength(20)
  @MaxLength(1000)
  readonly reason!: string;
}

export class AgreementMissingItemDto {
  @ApiProperty()
  readonly assetCode!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: 'number', nullable: true })
  readonly bookValue!: number | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly cause!: string | null;
}

export class AgreementSurplusItemDto {
  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly resolution!: string | null;
}

export class AgreementSummaryDto {
  @ApiProperty()
  readonly expected!: number;

  @ApiProperty()
  readonly found!: number;

  @ApiProperty()
  readonly misplaced!: number;

  @ApiProperty({ type: () => AgreementMissingItemDto, isArray: true })
  readonly missing!: AgreementMissingItemDto[];

  @ApiProperty({ type: () => AgreementSurplusItemDto, isArray: true })
  readonly surplus!: AgreementSurplusItemDto[];

  @ApiProperty()
  readonly bookValueAtRisk!: number;
}

export class ActAgreementResponseDto {
  @ApiProperty({ enum: AGREEMENT_STATUSES, enumName: 'AgreementStatus' })
  readonly status!: AgreementStatus;

  @ApiProperty({
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      code: { type: 'string' },
      name: { type: 'string' },
    },
  })
  readonly costCenter!: { id: string; code: string; name: string };

  @ApiProperty({ type: () => AgreementSummaryDto })
  readonly summary!: AgreementSummaryDto;

  @ApiProperty({ type: 'string', isArray: true })
  readonly companions!: string[];

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly respondedAt!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly comment!: string | null;
}
