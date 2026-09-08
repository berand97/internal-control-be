import { PartialType } from '@nestjs/swagger';
import { CreateBuildingDto } from './create-building.dto.js';

export class UpdateBuildingDto extends PartialType(CreateBuildingDto) {}
