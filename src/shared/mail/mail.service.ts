import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import { SecretCipherService } from '../crypto/secret-cipher.service.js';
import {
  MailSettingsResponseDto,
  MailTestResponseDto,
  MailVerifyResponseDto,
} from './dto/mail-settings.response.dto.js';
import type { UpdateMailSettingsDto } from './dto/update-mail-settings.dto.js';
import type { EmailTemplateType } from './domain/email-template-catalog.js';
import { EmailTemplatesService } from './email-templates.service.js';
import { MailSettings } from './entities/mail-settings.entity.js';
import { sendSmtpMail, verifySmtp } from './smtp-client.js';

const SECRET_FIELDS = ['host', 'username', 'password', 'fromName', 'fromEmail'] as const;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @InjectRepository(MailSettings)
    private readonly settings: Repository<MailSettings>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly templates: EmailTemplatesService,
    private readonly cipher: SecretCipherService,
  ) {}

  async getSettings(): Promise<MailSettingsResponseDto> {
    const row = await this.loadSettings();
    return MailSettingsResponseDto.from(
      row,
      this.hasConnection(row),
      this.isReady(row),
    );
  }

  async updateSettings(
    dto: UpdateMailSettingsDto,
    actorId: string,
  ): Promise<MailSettingsResponseDto> {
    const row = await this.loadSettings();
    const password =
      dto.password !== undefined && dto.password.length > 0
        ? dto.password
        : row.password;
    row.host = dto.host !== undefined ? dto.host.trim() || null : row.host;
    row.port = dto.port ?? row.port;
    row.secure = dto.secure ?? row.secure;
    if (row.port === 465) {
      row.secure = true;
    }
    row.username =
      dto.username !== undefined ? dto.username.trim() || null : row.username;
    row.password = password;
    row.fromName =
      dto.fromName !== undefined ? dto.fromName.trim() || null : row.fromName;
    row.fromEmail =
      dto.fromEmail !== undefined ? dto.fromEmail.trim() || null : row.fromEmail;
    row.enabled = dto.enabled ?? row.enabled;
    row.updatedAt = new Date();
    row.updatedBy = actorId;
    this.seal(row);
    await this.settings.save(row);
    return this.getSettings();
  }

  async verifyConnection(): Promise<MailVerifyResponseDto> {
    const row = await this.requireConnection();
    try {
      await verifySmtp({
        host: row.host ?? '',
        port: row.port,
        secure: row.secure || row.port === 465,
        username: row.username,
        password: row.password,
      });
    } catch (error) {
      this.logger.error(
        'smtp verify failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new ApiException(ErrorCode.MailSendFailed);
    }
    return { ok: true };
  }

  async testConnection(to?: string): Promise<MailTestResponseDto> {
    const row = await this.requireConnection();
    const recipient = to?.trim() || row.fromEmail;
    if (!recipient) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    await this.dispatch(
      row,
      recipient,
      'Prueba de correo — Control Interno UNAC',
      'Este es un mensaje de prueba. El SMTP quedó configurado correctamente.',
    );
    return { ok: true, to: recipient };
  }

  async sendPasswordReset(email: string, token: string): Promise<boolean> {
    const publicUrl = this.config.getOrThrow('appPublicUrl', { infer: true });
    const resetUrl = `${publicUrl}/auth/reset-password?token=${token}`;
    return this.sendTemplated(
      'PASSWORD_RESET',
      email,
      {
        'user.email': email,
        'auth.resetUrl': resetUrl,
        'auth.expiresInHours': '1',
        'app.name': 'Control Interno UNAC',
      },
      `password-reset to=${email}`,
    );
  }

  async sendUserInvitation(
    email: string,
    username: string,
    temporaryPassword: string,
    extras: {
      readonly roleName?: string;
      readonly fullName?: string;
    } = {},
  ): Promise<boolean> {
    const publicUrl = this.config.getOrThrow('appPublicUrl', { infer: true });
    const loginUrl = `${publicUrl}/auth/login`;
    return this.sendTemplated(
      'USER_INVITATION',
      email,
      {
        'user.email': email,
        'user.username': username,
        'user.fullName': extras.fullName ?? '',
        'user.role': extras.roleName ?? '',
        'auth.temporaryPassword': temporaryPassword,
        'auth.loginUrl': loginUrl,
        'app.name': 'Control Interno UNAC',
      },
      `user-invitation to=${email}`,
    );
  }

  /**
   * Enlace de firma de un acta (plantilla SIGNATURE_LINK). false si el SMTP no está configurado; lanza
   * MAIL_SEND_FAILED si el servidor rechaza el envío. El contexto trae el enlace: nunca va al log.
   */
  async sendSigningLink(
    to: string,
    context: {
      readonly url: string;
      readonly expiresAt: string;
      readonly formatName: string;
      readonly number: string;
      readonly signerName: string;
      readonly roleLabel: string;
      readonly contact: string;
    },
  ): Promise<boolean> {
    return this.sendTemplated(
      'SIGNATURE_LINK',
      to,
      {
        'firma.url': context.url,
        'firma.vence': context.expiresAt,
        'firma.rol': context.roleLabel,
        'firmante.nombre': context.signerName,
        'acta.formato': context.formatName,
        'acta.numero': context.number,
        contacto: context.contact,
        'app.name': 'Control Interno UNAC',
      },
      `signature-link acta=${context.number}`,
    );
  }

  async sendTemplated(
    templateType: EmailTemplateType,
    to: string,
    context: Record<string, string>,
    fallbackLog: string,
  ): Promise<boolean> {
    const rendered = await this.templates.render(templateType, context);
    return this.sendOrLog(to, rendered.subject, rendered.text, fallbackLog);
  }

  private async sendOrLog(
    to: string,
    subject: string,
    text: string,
    fallbackLog: string,
  ): Promise<boolean> {
    const row = await this.loadSettings();
    if (!this.isReady(row)) {
      this.logger.warn(`smtp not configured; ${fallbackLog}`);
      return false;
    }
    await this.dispatch(row, to, subject, text);
    return true;
  }

  private async dispatch(
    row: MailSettings,
    to: string,
    subject: string,
    text: string,
  ): Promise<void> {
    const from = row.fromName
      ? `${row.fromName} <${row.fromEmail}>`
      : (row.fromEmail ?? '');
    try {
      await sendSmtpMail({
        host: row.host ?? '',
        port: row.port,
        secure: row.secure || row.port === 465,
        username: row.username,
        password: row.password,
        from,
        to,
        subject,
        text,
      });
    } catch (error) {
      this.logger.error(
        `smtp send failed to=${to} subject=${subject}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ApiException(ErrorCode.MailSendFailed);
    }
  }

  private hasConnection(row: MailSettings): boolean {
    return Boolean(row.host?.trim()) && Boolean(row.fromEmail?.trim());
  }

  private isReady(row: MailSettings): boolean {
    return row.enabled === true && this.hasConnection(row);
  }

  private async requireConnection(): Promise<MailSettings> {
    const row = await this.loadSettings();
    if (!this.hasConnection(row)) {
      throw new ApiException(ErrorCode.MailNotConfigured);
    }
    return row;
  }

  private async loadSettings(): Promise<MailSettings> {
    const stored = await this.requireStored();
    if (this.hasPlaintextSecrets(stored)) {
      this.seal(stored);
      await this.settings.save(stored);
    }
    return this.reveal(stored);
  }

  private async requireStored(): Promise<MailSettings> {
    const existing = await this.settings.find({ take: 1 }).then((rows) => rows[0]);
    if (existing) {
      return existing;
    }
    const created = this.settings.create({
      host: null,
      port: 587,
      secure: false,
      username: null,
      password: null,
      fromName: null,
      fromEmail: null,
      enabled: false,
      updatedAt: new Date(),
      updatedBy: null,
    });
    return this.settings.save(created);
  }

  private hasPlaintextSecrets(row: MailSettings): boolean {
    return SECRET_FIELDS.some((field) => {
      const value = row[field];
      return value !== null && value !== '' && !this.cipher.isEncrypted(value);
    });
  }

  private seal(row: MailSettings): void {
    row.host = this.cipher.encrypt(row.host);
    row.username = this.cipher.encrypt(row.username);
    row.password = this.cipher.encrypt(row.password);
    row.fromName = this.cipher.encrypt(row.fromName);
    row.fromEmail = this.cipher.encrypt(row.fromEmail);
  }

  private reveal(row: MailSettings): MailSettings {
    try {
      return this.settings.create({
        ...row,
        host: this.cipher.decrypt(row.host),
        username: this.cipher.decrypt(row.username),
        password: this.cipher.decrypt(row.password),
        fromName: this.cipher.decrypt(row.fromName),
        fromEmail: this.cipher.decrypt(row.fromEmail),
      });
    } catch (error) {
      this.logger.error(
        'mail settings decrypt failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new ApiException(ErrorCode.InternalError);
    }
  }
}
