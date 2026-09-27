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
import {
  assertDestinationAllowed,
  isOutboundForbidden,
  type OutboundPolicy,
} from '../net/outbound-destination.js';
import { maskEmail, redactEmails, UnsafeMailFieldError } from './mail-address.js';
import { sendSmtpMail, verifySmtp } from './smtp-client.js';

/** Pila o mensaje de un error de SMTP sin correos de personas (la respuesta del servidor suele repetir el RCPT). */
const describeError = (error: unknown): string =>
  redactEmails(error instanceof Error ? (error.stack ?? error.message) : String(error));

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
    if (dto.host !== undefined && dto.host.trim() !== '') {
      await this.assertHostAllowed(dto.host.trim());
    }
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
        outbound: this.outboundPolicy(),
      });
    } catch (error) {
      this.logger.error('smtp verify failed', describeError(error));
      if (isOutboundForbidden(error)) {
        throw new ApiException(ErrorCode.OutboundDestinationForbidden);
      }
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
      // Ley 1581: el log de respaldo no lleva el correo completo.
      `password-reset to=${maskEmail(email)}`,
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
      `user-invitation to=${maskEmail(email)}`,
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
        outbound: this.outboundPolicy(),
      });
    } catch (error) {
      if (error instanceof UnsafeMailFieldError) {
        // Ni la dirección ni el nombre rechazados van al log: son datos personales y pueden traer CR/LF (BE-06).
        this.logger.warn(`smtp send rejected before connecting: unsafe ${error.field}`);
        throw new ApiException(ErrorCode.MailAddressInvalid);
      }
      // Ley 1581: ni el destinatario completo ni el asunto (puede llevar nombres) van al log.
      this.logger.error(`smtp send failed to=${maskEmail(to)}`, describeError(error));
      if (isOutboundForbidden(error)) {
        throw new ApiException(ErrorCode.OutboundDestinationForbidden);
      }
      throw new ApiException(ErrorCode.MailSendFailed);
    }
  }

  private outboundPolicy(): OutboundPolicy {
    return this.config.getOrThrow('outbound', { infer: true });
  }

  /** El host SMTP no puede apuntar a la red interna del despliegue (BE-16). */
  private async assertHostAllowed(host: string): Promise<void> {
    try {
      await assertDestinationAllowed(host, this.outboundPolicy());
    } catch (error) {
      if (isOutboundForbidden(error)) {
        throw new ApiException(ErrorCode.OutboundDestinationForbidden);
      }
      throw error;
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
    const revealed = this.reveal(stored);
    // En claro (legado) o cifrado con SETTINGS_ENCRYPTION_KEY_PREVIOUS: se vuelve a sellar con la clave actual.
    if (this.needsReseal(stored)) {
      const resealed = this.settings.create({ ...revealed });
      this.seal(resealed);
      await this.settings.save(resealed);
    }
    return revealed;
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

  private needsReseal(row: MailSettings): boolean {
    return SECRET_FIELDS.some((field) => this.cipher.needsReseal(row[field]));
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
