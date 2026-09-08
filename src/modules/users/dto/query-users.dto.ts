import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { UserStatus } from '../../auth/enums/user-status.enum.js';

export class QueryUsersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  readonly status?: UserStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filtra por rol activo' })
  @IsOptional()
  @IsUUID('4')
  readonly roleId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filtra por scope de centro de costo',
  })
  @IsOptional()
  @IsUUID('4')
  readonly costCenterId?: string;
}
