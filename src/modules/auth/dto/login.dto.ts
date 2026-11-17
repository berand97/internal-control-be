import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description:
      'Usuario o correo institucional. Acepta la parte local (juliana.perez) o el correo completo (@unac.edu.co).',
    example: 'juliana.perez',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  readonly username!: string;

  @ApiProperty({
    description: 'Contraseña en texto plano (viaja sólo por HTTPS)',
    example: 'C0ntraseña-Segura!',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly password!: string;
}
