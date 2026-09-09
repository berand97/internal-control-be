import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';

const PREFIX = 'enc.v1.';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class SecretCipherService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plain: string | null | undefined): string | null {
    if (plain === undefined || plain === null || plain === '') {
      return null;
    }
    if (this.isEncrypted(plain)) {
      return plain;
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX + iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (!this.isEncrypted(value)) {
      return value;
    }
    const payload = value.slice(PREFIX.length);
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (!ivPart || !tagPart || !dataPart) {
      throw new Error('Dato cifrado de configuración corrupto');
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const data = Buffer.from(dataPart, 'base64url');
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Dato cifrado de configuración corrupto');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  private key(): Buffer {
    return createHash('sha256')
      .update(this.config.getOrThrow('settingsEncryptionKey', { infer: true }))
      .digest();
  }
}
