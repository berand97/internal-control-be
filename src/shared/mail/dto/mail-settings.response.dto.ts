import { ApiProperty } from '@nestjs/swagger';
import type { MailSettings } from '../entities/mail-settings.entity.js';

export class MailSettingsResponseDto {
  @ApiProperty({ nullable: true })
  readonly host!: string | null;

  @ApiProperty()
  readonly port!: number;

  @ApiProperty()
  readonly secure!: boolean;

  @ApiProperty({ nullable: true })
  readonly username!: string | null;

  @ApiProperty()
  readonly hasPassword!: boolean;

  @ApiProperty({ nullable: true })
  readonly fromName!: string | null;

  @ApiProperty({ nullable: true })
  readonly fromEmail!: string | null;

  @ApiProperty()
  readonly enabled!: boolean;

  @ApiProperty({ description: 'Hay host y remitente; se puede probar el SMTP' })
  readonly testable!: boolean;

  @ApiProperty({ description: 'Activo y listo para invitaciones' })
  readonly configured!: boolean;

  static from(
    row: MailSettings,
    testable: boolean,
    configured: boolean,
  ): MailSettingsResponseDto {
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      hasPassword: Boolean(row.password),
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      enabled: row.enabled,
      testable,
      configured,
    };
  }
}

export class MailTestResponseDto {
  @ApiProperty()
  readonly ok!: boolean;

  @ApiProperty()
  readonly to!: string;
}

export class MailVerifyResponseDto {
  @ApiProperty()
  readonly ok!: boolean;
}
