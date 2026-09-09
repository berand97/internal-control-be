import { PartialType } from '@nestjs/swagger';
import { CreateNavigationItemDto } from './create-navigation-item.dto.js';

export class UpdateNavigationItemDto extends PartialType(
  CreateNavigationItemDto,
) {}
