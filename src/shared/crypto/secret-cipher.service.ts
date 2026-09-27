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

const deriveKey = (secret: string): Buffer => createHash('sha256').update(secret).digest();

const isSealed = (value: string): boolean => value.startsWith(PREFIX);

/** AES-256-GCM con IV aleatorio: `enc.v1.<iv>.<tag>.<datos>` (base64url). La clave es SHA-256 del secreto. */
export const sealSecret = (plain: string, secret: string): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX + iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
};

/**
 * Descifra con la primera clave que autentique el dato (la actual y luego las anteriores: rotación, BE-12).
 * Devuelve también el índice de la clave usada. Lanza si ninguna sirve o el dato está corrupto.
 */
export const openSecret = (
  value: string,
  secrets: ReadonlyArray<string>,
): { readonly plain: string; readonly keyIndex: number } => {
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
  for (const [keyIndex, secret] of secrets.entries()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
      decipher.setAuthTag(tag);
      return { plain: Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'), keyIndex };
    } catch {
      // Clave equivocada: la etiqueta GCM no autentica. Se prueba la siguiente.
    }
  }
  throw new Error('Ninguna clave de SETTINGS_ENCRYPTION_KEY descifra el dato');
};

export const isSealedSecret = isSealed;

@Injectable()
export class SecretCipherService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  isEncrypted(value: string): boolean {
    return isSealed(value);
  }

  encrypt(plain: string | null | undefined): string | null {
    if (plain === undefined || plain === null || plain === '') {
      return null;
    }
    if (this.isEncrypted(plain)) {
      return plain;
    }
    return sealSecret(plain, this.currentKey());
  }

  decrypt(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (!this.isEncrypted(value)) {
      return value;
    }
    return openSecret(value, this.keys()).plain;
  }

  /**
   * true si el valor está en claro o cifrado con una clave anterior: quien lo guarda debe volver a sellarlo
   * (decrypt + encrypt) para completar la rotación. Un dato que ninguna clave descifra lanza.
   */
  needsReseal(value: string | null | undefined): boolean {
    if (value === undefined || value === null || value === '') {
      return false;
    }
    if (!this.isEncrypted(value)) {
      return true;
    }
    return openSecret(value, this.keys()).keyIndex !== 0;
  }

  private currentKey(): string {
    return this.config.getOrThrow('settingsEncryptionKey', { infer: true });
  }

  private keys(): ReadonlyArray<string> {
    const previous: unknown = this.config.getOrThrow('settingsEncryptionPreviousKeys', { infer: true });
    return [this.currentKey(), ...(Array.isArray(previous) ? previous.filter((item) => typeof item === 'string') : [])];
  }
}
