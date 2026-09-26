import { ApiProperty } from '@nestjs/swagger';
import { NAVIGATION_ICONS, type NavigationIcon } from '../../../../common/authorization/navigation-icons.js';
import type { NavigationDefinition } from '../../../../common/authorization/navigation.registry.js';
import type { NavigationItemEntity } from '../../entities/navigation-item.entity.js';

export class NavigationAdminItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly module!: string;

  @ApiProperty()
  readonly moduleLabel!: string;

  @ApiProperty()
  readonly resource!: string;

  @ApiProperty()
  readonly path!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty()
  readonly requiredAction!: string;

  @ApiProperty({
    enum: NAVIGATION_ICONS,
    enumName: 'NavigationIcon',
    nullable: true,
    description: 'Clave de ícono Lucide del catálogo cerrado (GET /navigation/icons); null sin ícono propio',
  })
  readonly icon!: NavigationIcon | null;

  @ApiProperty()
  readonly sortOrder!: number;

  @ApiProperty()
  readonly isActive!: boolean;

  static from(item: NavigationItemEntity): NavigationAdminItemResponseDto {
    return {
      id: item.id,
      module: item.module,
      moduleLabel: item.moduleLabel,
      resource: item.resource,
      path: item.path,
      label: item.label,
      requiredAction: item.requiredAction,
      icon: item.icon,
      sortOrder: item.sortOrder,
      isActive: item.isActive,
    };
  }

  static toDefinition(item: NavigationItemEntity): NavigationDefinition {
    return {
      module: item.module,
      moduleLabel: item.moduleLabel,
      resource: item.resource,
      path: item.path,
      label: item.label,
      requiredAction: item.requiredAction,
      sortOrder: item.sortOrder,
      icon: item.icon,
    };
  }
}
