import { PartialType } from '@nestjs/swagger';
import { CreateCampusDto } from './create-campus.dto.js';

export class UpdateCampusDto extends PartialType(CreateCampusDto) {}
