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

  async sendUserActivation(email: string, token: string): Promise<void> {
    const publicUrl = this.config.getOrThrow('appPublicUrl', { infer: true });
    const activationUrl = `${publicUrl}/auth/reset-password?token=${token}`;
    this.logger.log(`user-activation to=${email} url=${activationUrl}`);
    await Promise.resolve();
  }
}
