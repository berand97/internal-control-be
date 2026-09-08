import { ApiProperty } from '@nestjs/swagger';
import type { AppUser } from '../../entities/app-user.entity.js';
import { AuthUserResponseDto } from './auth-user.response.dto.js';

export class LoginResponseDto {
  @ApiProperty({
    description:
      'Access token JWT. El cliente debe conservarlo sólo en memoria.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  readonly accessToken!: string;

  @ApiProperty({
    description: 'Vida restante del access token en segundos',
    example: 900,
  })
  readonly expiresIn!: number;

  @ApiProperty({
    description: 'Usuario autenticado con sus roles activos',
    type: AuthUserResponseDto,
  })
  readonly user!: AuthUserResponseDto;

  static from(
    accessToken: string,
    expiresIn: number,
    user: AppUser,
    roles: ReadonlyArray<string>,
  ): LoginResponseDto {
    const authUser: AuthUserResponseDto = {
      id: user.id,
      username: user.username,
      roles,
      mustChangePassword: user.mustChangePassword === true,
    };
    return { accessToken, expiresIn, user: authUser };
  }
}
