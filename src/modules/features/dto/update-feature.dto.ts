import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateFeatureDto {
  @ApiProperty({ description: 'true reactiva el módulo; false lo apaga' })
  @IsBoolean()
  readonly enabled!: boolean;
}
