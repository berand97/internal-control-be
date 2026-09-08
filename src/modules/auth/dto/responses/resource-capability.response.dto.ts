import { ApiProperty } from '@nestjs/swagger';
import type { ResourceCapability } from '../../../../common/authorization/granted-permission.type.js';

export class ResourceCapabilityResponseDto {
  @ApiProperty({ example: 'campus' })
  readonly resource!: string;

  @ApiProperty({ example: 'STRUCTURE' })
  readonly module!: string;

  @ApiProperty({ type: [String], example: ['read', 'manage'] })
  readonly actions!: ReadonlyArray<string>;

  @ApiProperty({ type: [String], example: ['GLOBAL'] })
  readonly scopes!: ReadonlyArray<string>;

  static from(capability: ResourceCapability): ResourceCapabilityResponseDto {
    return {
      resource: capability.resource,
      module: capability.module,
      actions: capability.actions,
      scopes: capability.scopes,
    };
  }
}
