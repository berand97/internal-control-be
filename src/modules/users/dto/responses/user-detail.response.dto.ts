import { ApiProperty } from '@nestjs/swagger';
import type { AppUser } from '../../../auth/entities/app-user.entity.js';
import type { UserRole } from '../../../auth/entities/user-role.entity.js';
import { UserListItemResponseDto } from './user-list-item.response.dto.js';
import { UserRoleResponseDto } from './user-role.response.dto.js';

export class UserDetailResponseDto extends UserListItemResponseDto {
  @ApiProperty({ nullable: true })
  readonly phone!: string | null;

  @ApiProperty({ nullable: true })
  readonly positionTitle!: string | null;

  @ApiProperty()
  readonly documentType!: string;

  @ApiProperty()
  readonly documentNumber!: string;

  @ApiProperty({ type: [UserRoleResponseDto] })
  readonly roles!: ReadonlyArray<UserRoleResponseDto>;

  static fromDetail(
    user: AppUser,
    roles: ReadonlyArray<UserRole>,
  ): UserDetailResponseDto {
    const person = user.person;
    return {
      ...UserListItemResponseDto.from(user),
      phone: person?.phone ?? null,
      positionTitle: person?.positionTitle ?? null,
      documentType: person?.documentType ?? '',
      documentNumber: person?.documentNumber ?? '',
      roles: roles.map(UserRoleResponseDto.from),
    };
  }
}
