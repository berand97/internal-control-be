import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  FeatureDisabledReason,
  FeatureSnapshot,
} from '../feature-catalog.js';

export class FeatureResponseDto {
  @ApiProperty({ example: 'loans' })
  readonly code!: string;

  @ApiProperty({ example: 'Préstamos' })
  readonly label!: string;

  @ApiProperty({
    description:
      'Si es false, el frontend oculta el módulo y no llama sus endpoints',
  })
  readonly enabled!: boolean;

  @ApiProperty({
    description: 'Los módulos core no se pueden apagar (auth, roles, users)',
  })
  readonly core!: boolean;

  @ApiPropertyOptional({
    enum: ['MANUAL', 'CIRCUIT', 'ENV'],
    nullable: true,
    description:
      'MANUAL = operador, CIRCUIT = errores internos consecutivos, ENV = variable de entorno',
  })
  readonly reason!: FeatureDisabledReason | null;

  static from(feature: FeatureSnapshot): FeatureResponseDto {
    return {
      code: feature.code,
      label: feature.label,
      enabled: feature.enabled,
      core: feature.core,
      reason: feature.reason,
    };
  }
}
