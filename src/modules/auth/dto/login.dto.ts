import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description:
      'Nombre de usuario o correo institucional (@unac.edu.co). En cuentas invitadas el usuario es el correo.',
    example: 'juliana.perez@unac.edu.co',
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
