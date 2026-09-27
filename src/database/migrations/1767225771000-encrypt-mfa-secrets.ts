import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-11: cifra en reposo las semillas TOTP existentes (app_user.mfa_secret y mfa_pending_secret) con el mismo
 * formato y la misma clave que SecretCipherService (src/shared/crypto/secret-cipher.service.ts): AES-256-GCM,
 * IV aleatorio de 12 bytes, clave = SHA-256 de SETTINGS_ENCRYPTION_KEY, o de JWT_ACCESS_SECRET si aquella no está
 * definida (el mismo respaldo que src/config/configuration.ts). Formato: enc.v1.<iv>.<tag>.<dato> en base64url.
 *
 * La lógica se copia aquí a propósito: una migración no debe cambiar de comportamiento si el servicio cambia.
 * Es idempotente (lo ya cifrado no se toca) y reversible: down() descifra con la misma clave.
 * Si hay semillas que procesar y no hay clave en el entorno, falla sin tocar nada (nunca cifra con una clave
 * distinta de la que usará la aplicación).
 */
const PREFIX = 'enc.v1.';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const readKey = (): Buffer | null => {
  const configured = process.env['SETTINGS_ENCRYPTION_KEY'];
  const fallback = process.env['JWT_ACCESS_SECRET'];
  const material =
    configured !== undefined && configured !== ''
      ? configured
      : fallback !== undefined && fallback !== ''
        ? fallback
        : null;
  return material === null
    ? null
    : createHash('sha256').update(material).digest();
};

const requireKey = (pending: number): Buffer => {
  const key = readKey();
  if (key === null) {
    throw new Error(
      `Hay ${pending} semilla(s) TOTP por procesar y no está definida SETTINGS_ENCRYPTION_KEY (ni JWT_ACCESS_SECRET). ` +
        'Defina la misma clave que usa la aplicación y vuelva a ejecutar la migración.',
    );
  }
  return key;
};

const encrypt = (plain: string, key: Buffer): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    PREFIX + iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join('.');
};

const decrypt = (value: string, key: Buffer): string => {
  const [ivPart, tagPart, dataPart] = value.slice(PREFIX.length).split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Semilla TOTP cifrada corrupta');
  }
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Semilla TOTP cifrada corrupta');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

interface SecretRow {
  readonly id: string;
  readonly mfa_secret: string | null;
  readonly mfa_pending_secret: string | null;
}

export class EncryptMfaSecrets1767225771000 implements MigrationInterface {
  name = 'EncryptMfaSecrets1767225771000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.transform(queryRunner, 'encrypt');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.transform(queryRunner, 'decrypt');
  }

  private async transform(
    queryRunner: QueryRunner,
    direction: 'encrypt' | 'decrypt',
  ): Promise<void> {
    // encrypt: filas con alguna semilla en claro; decrypt: filas con alguna semilla cifrada.
    const matches = direction === 'encrypt' ? 'NOT LIKE' : 'LIKE';
    const rows = (await queryRunner.query(
      `SELECT id, mfa_secret, mfa_pending_secret FROM app_user
       WHERE (mfa_secret IS NOT NULL AND mfa_secret <> '' AND mfa_secret ${matches} 'enc.v1.%')
          OR (mfa_pending_secret IS NOT NULL AND mfa_pending_secret <> '' AND mfa_pending_secret ${matches} 'enc.v1.%')
       FOR UPDATE`,
    )) as SecretRow[];
    if (rows.length === 0) {
      return;
    }
    const key = requireKey(rows.length);
    const convert = (value: string | null): string | null => {
      if (value === null || value === '') {
        return value;
      }
      const sealed = value.startsWith(PREFIX);
      if (direction === 'encrypt') {
        return sealed ? value : encrypt(value, key);
      }
      return sealed ? decrypt(value, key) : value;
    };
    for (const row of rows) {
      await queryRunner.query(
        'UPDATE app_user SET mfa_secret = $2, mfa_pending_secret = $3 WHERE id = $1',
        [row.id, convert(row.mfa_secret), convert(row.mfa_pending_secret)],
      );
    }
  }
}
