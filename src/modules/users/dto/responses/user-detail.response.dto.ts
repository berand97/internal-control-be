import { ApiProperty } from '@nestjs/swagger';
import type { NavigationItem } from '../../../../common/authorization/granted-permission.type.js';
import { NavigationItemResponseDto } from '../../../auth/dto/responses/navigation-item.response.dto.js';
import type { AppUser } from '../../../auth/entities/app-user.entity.js';
import type { UserRole } from '../../../auth/entities/user-role.entity.js';
import { UserListItemResponseDto } from './user-list-item.response.dto.js';
import { UserRoleResponseDto } from './user-role.response.dto.js';

export class UserDetailResponseDto extends UserListItemResponseDto {
  @ApiProperty({ nullable: true })
  readonly phone!: string | null;

  @ApiProperty({ nullable: true })
  readonly positionTitle!: string | null;

  @ApiProperty({ nullable: true })
  readonly documentType!: string | null;

  @ApiProperty({ nullable: true })
  readonly documentNumber!: string | null;

  @ApiProperty({ type: [UserRoleResponseDto] })
  readonly roles!: ReadonlyArray<UserRoleResponseDto>;

  @ApiProperty({
    type: [NavigationItemResponseDto],
    description:
      'Menús efectivos del usuario según sus roles. Se recalculan al asignar o quitar un rol.',
  })
  readonly navigation!: ReadonlyArray<NavigationItemResponseDto>;

  @ApiProperty({
    description: 'False si la cuenta se creó pero el SMTP no está configurado',
    required: false,
  })
  readonly invitationSent?: boolean;

  static fromDetail(
    user: AppUser,
    roles: ReadonlyArray<UserRole>,
    navigation: ReadonlyArray<NavigationItem> = [],
    invitationSent?: boolean,
  ): UserDetailResponseDto {
    const person = user.person;
    return {
      ...UserListItemResponseDto.from(user),
      phone: person?.phone ?? null,
      positionTitle: person?.positionTitle ?? null,
      documentType: person?.documentType ?? null,
      documentNumber: person?.documentNumber ?? null,
      roles: roles.map(UserRoleResponseDto.from),
      navigation: navigation.map(NavigationItemResponseDto.from),
      ...(invitationSent === undefined ? {} : { invitationSent }),
    };
  }
}
