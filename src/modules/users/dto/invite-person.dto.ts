import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class InvitePersonDto {
  @ApiProperty({ format: 'uuid', description: 'Persona existente a la que se le crea la cuenta' })
  @IsUUID('4')
  readonly personId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Rol con el que se invita al usuario',
  })
  @IsUUID('4')
  readonly roleId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Departamento. Obligatorio si la persona no tiene dependencia ni centro, o si no se envía centro.',
  })
  @IsOptional()
  @IsUUID('4')
  readonly organizationalUnitId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Centro de costo. Si se omite el departamento, se toma el de este centro o el de la persona.',
  })
  @IsOptional()
  @IsUUID('4')
  readonly costCenterId?: string;
}
