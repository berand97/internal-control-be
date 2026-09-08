import { ApiProperty } from '@nestjs/swagger';
import type { PaginatedResult } from '../../../../common/types/paginated-result.type.js';
import { UserListItemResponseDto } from './user-list-item.response.dto.js';

class PaginationMetaDto {
  @ApiProperty()
  readonly page!: number;

  @ApiProperty()
  readonly pageSize!: number;

  @ApiProperty()
  readonly totalItems!: number;

  @ApiProperty()
  readonly totalPages!: number;
}

export class UsersPageResponseDto {
  @ApiProperty({ type: [UserListItemResponseDto] })
  readonly items!: ReadonlyArray<UserListItemResponseDto>;

  @ApiProperty({ type: PaginationMetaDto })
  readonly pagination!: PaginationMetaDto;

  static from(
    result: PaginatedResult<UserListItemResponseDto>,
  ): UsersPageResponseDto {
    return {
      items: result.items,
      pagination: result.pagination,
    };
  }
}
