import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

export class ReconcileStructureDto {
  @ApiPropertyOptional({
    description: 'hash de GET /organizational-units/reconcile/preview: si el plan cambió desde entonces, 409 STRUCTURE_RECONCILE_STALE',
    example: '3f1c…',
  })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/, { message: 'La vista previa no es válida. Ábrala de nuevo.' })
  readonly expectedHash?: string;
}
