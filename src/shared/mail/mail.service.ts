import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async sendPasswordReset(email: string, token: string): Promise<void> {
    const publicUrl = this.config.getOrThrow('appPublicUrl', { infer: true });
    const resetUrl = `${publicUrl}/auth/reset-password?token=${token}`;
    this.logger.log(`password-reset to=${email} url=${resetUrl}`);
    await Promise.resolve();
  }

  async sendUserInvitation(
    email: string,
    username: string,
    temporaryPassword: string,
  ): Promise<void> {
    const publicUrl = this.config.getOrThrow('appPublicUrl', { infer: true });
    const loginUrl = `${publicUrl}/auth/login`;
    this.logger.log(
      `user-invitation to=${email} username=${username} loginUrl=${loginUrl} temporaryPassword=${temporaryPassword}`,
    );
    await Promise.resolve();
  }
}
