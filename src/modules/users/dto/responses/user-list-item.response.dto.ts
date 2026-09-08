import { ApiProperty } from '@nestjs/swagger';
import type { AppUser } from '../../../auth/entities/app-user.entity.js';

export class UserListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly username!: string;

  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty()
  readonly fullName!: string;

  @ApiProperty()
  readonly email!: string;

  @ApiProperty()
  readonly status!: string;

  @ApiProperty()
  readonly mfaEnabled!: boolean;

  @ApiProperty({
    description:
      'True si el usuario debe cambiar la contraseña temporal de la invitación',
  })
  readonly mustChangePassword!: boolean;

  static from(user: AppUser): UserListItemResponseDto {
    const person = user.person;
    return {
      id: user.id,
      username: user.username,
      personId: user.personId,
      fullName: person ? `${person.firstName} ${person.lastName}` : '',
      email: person?.email ?? '',
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: user.mustChangePassword === true,
    };
  }
}
