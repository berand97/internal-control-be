import { ApiProperty } from '@nestjs/swagger';
import type { NavigationItem } from '../../../../common/authorization/granted-permission.type.js';

export class NavigationItemResponseDto {
  @ApiProperty({ example: 'STRUCTURE' })
  readonly module!: string;

  @ApiProperty({ example: 'Estructura' })
  readonly moduleLabel!: string;

  @ApiProperty({ example: 'campus' })
  readonly resource!: string;

  @ApiProperty({ example: '/campus' })
  readonly path!: string;

  @ApiProperty({ example: 'Campus y ubicaciones' })
  readonly label!: string;

  static from(item: NavigationItem): NavigationItemResponseDto {
    return {
      module: item.module,
      moduleLabel: item.moduleLabel,
      resource: item.resource,
      path: item.path,
      label: item.label,
    };
  }
}
