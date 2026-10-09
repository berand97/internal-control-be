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
    enum: ['MANUAL', 'CIRCUIT', 'ENV', 'DEFAULT'],
    nullable: true,
    description:
      'Solo con enabled=false. MANUAL = operador, CIRCUIT = demasiados errores internos seguidos en poco tiempo ' +
      '(se reactiva solo, ver retryAt), ENV = variable de entorno, DEFAULT = apagado por defecto en el catálogo',
  })
  readonly reason!: FeatureDisabledReason | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-08T15:05:00.000Z',
    description:
      'Solo con reason=CIRCUIT: desde cuándo el módulo vuelve a mostrarse y deja pasar una petición de prueba. ' +
      'Si responde bien se reactiva solo; si falla, el circuito sigue abierto y retryAt se corre. ' +
      'Con MANUAL y ENV es null: esos no se reactivan solos.',
  })
  readonly retryAt!: string | null;

  static from(feature: FeatureSnapshot): FeatureResponseDto {
    return {
      code: feature.code,
      label: feature.label,
      enabled: feature.enabled,
      core: feature.core,
      reason: feature.reason,
      retryAt: feature.retryAt?.toISOString() ?? null,
    };
  }
}
