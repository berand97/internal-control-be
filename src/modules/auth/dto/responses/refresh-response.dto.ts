import { ApiProperty } from '@nestjs/swagger';

export class RefreshResponseDto {
  @ApiProperty({
    description:
      'Nuevo access token JWT. El refresh token rotado viaja sólo en cookie HttpOnly.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  readonly accessToken!: string;

  @ApiProperty({
    description: 'Vida restante del access token en segundos',
    example: 900,
  })
  readonly expiresIn!: number;

  static from(accessToken: string, expiresIn: number): RefreshResponseDto {
    return { accessToken, expiresIn };
  }
}
