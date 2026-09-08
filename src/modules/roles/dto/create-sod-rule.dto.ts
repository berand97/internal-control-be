import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { SodConstraintType } from '../enums/sod-constraint-type.enum.js';

export class CreateSodRuleDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly roleAId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly roleBId!: string;

  @ApiProperty({ enum: SodConstraintType })
  @IsEnum(SodConstraintType)
  readonly constraintType!: SodConstraintType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly reason!: string;
}
