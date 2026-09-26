import { ApiProperty } from '@nestjs/swagger';
import type { NavigationItem } from '../../../../common/authorization/granted-permission.type.js';
import { NAVIGATION_ICONS, type NavigationIcon } from '../../../../common/authorization/navigation-icons.js';

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

  @ApiProperty({
    enum: NAVIGATION_ICONS,
    enumName: 'NavigationIcon',
    nullable: true,
    example: 'map-pinned',
    description: 'Clave de ícono Lucide del catálogo cerrado; null si el ítem no tiene uno (el cliente usa su ícono por defecto)',
  })
  readonly icon!: NavigationIcon | null;

  static from(item: NavigationItem): NavigationItemResponseDto {
    return {
      module: item.module,
      moduleLabel: item.moduleLabel,
      resource: item.resource,
      path: item.path,
      label: item.label,
      icon: item.icon,
    };
  }
}
