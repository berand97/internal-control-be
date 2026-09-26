import { ApiProperty } from '@nestjs/swagger';
import { NAVIGATION_ICONS, type NavigationIcon } from '../../../../common/authorization/navigation-icons.js';

export class NavigationIconCatalogResponseDto {
  @ApiProperty({
    enum: NAVIGATION_ICONS,
    enumName: 'NavigationIcon',
    isArray: true,
    description: 'Claves de ícono Lucide que acepta un ítem de menú, en el orden del catálogo',
  })
  readonly icons!: ReadonlyArray<NavigationIcon>;
}
