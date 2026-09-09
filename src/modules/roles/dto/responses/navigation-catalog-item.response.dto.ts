import { ApiProperty } from '@nestjs/swagger';
import type { NavigationDefinition } from '../../../../common/authorization/navigation.registry.js';

export class NavigationCatalogItemResponseDto {
  @ApiProperty({ example: 'USER' })
  readonly module!: string;

  @ApiProperty({ example: 'Administración' })
  readonly moduleLabel!: string;

  @ApiProperty({ example: 'user' })
  readonly resource!: string;

  @ApiProperty({ example: '/users' })
  readonly path!: string;

  @ApiProperty({ example: 'Usuarios' })
  readonly label!: string;

  @ApiProperty({ example: 'read' })
  readonly requiredAction!: string;

  @ApiProperty({ example: 10 })
  readonly sortOrder!: number;

  static from(
    item: NavigationDefinition,
  ): NavigationCatalogItemResponseDto {
    return {
      module: item.module,
      moduleLabel: item.moduleLabel,
      resource: item.resource,
      path: item.path,
      label: item.label,
      requiredAction: item.requiredAction,
      sortOrder: item.sortOrder,
    };
  }
}
