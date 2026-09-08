import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description:
      'Nombre de usuario o correo institucional (@unac.edu.co). El campo se llama username por contrato de AUTHENTICATION.md.',
    example: 'juliana.perez@unac.edu.co',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
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
