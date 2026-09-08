import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import type { AppConfig } from '../../config/configuration.js';

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$YzNtpRO1I5ihhVOS8MUzWQ$CWcgTD62NWKONCSvLBolTJpw+yUhrpeexNcbnI0tYIw';

@Injectable()
export class HashService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async hash(plain: string): Promise<string> {
    const argon2Config = this.config.getOrThrow('argon2', { infer: true });
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: argon2Config.memoryCost,
      timeCost: argon2Config.timeCost,
      parallelism: argon2Config.parallelism,
    });
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hashed, plain);
    } catch {
      return false;
    }
  }

  async runDummyVerification(plain: string): Promise<void> {
    await argon2.verify(DUMMY_PASSWORD_HASH, plain).catch((): false => false);
  }
}
