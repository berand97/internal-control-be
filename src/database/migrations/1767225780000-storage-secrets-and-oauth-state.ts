import type { MigrationInterface, QueryRunner } from 'typeorm';
import { resolveDedicatedSecrets } from '../../config/dedicated-secrets.js';
import { isSealedSecret, openSecret, sealSecret } from '../../shared/crypto/secret-cipher.service.js';

/**
 * BE-11: las credenciales de almacenamiento (s3_secret_key, google_client_secret, google_refresh_token,
 * onedrive_client_secret, onedrive_refresh_token) pasan a guardarse cifradas con SETTINGS_ENCRYPTION_KEY
 * (AES-256-GCM, mismo formato `enc.v1.` que la configuración SMTP). up() cifra las que estén en claro; down()
 * las devuelve a texto plano. La clave es la misma que usa la aplicación (SETTINGS_ENCRYPTION_KEY o, fuera de
 * producción, JWT_ACCESS_SECRET): la migración corre en el mismo contenedor, con el mismo entorno.
 *
 * BE-15: storage_oauth_state guarda el `state` OAuth de un solo uso (solo su hash SHA-256), el hash de la cookie
 * que lo liga al navegador, el usuario, el proveedor, la caducidad y cuándo se consumió.
 */
const SECRET_COLUMNS = [
  's3_secret_key',
  'google_client_secret',
  'google_refresh_token',
  'onedrive_client_secret',
  'onedrive_refresh_token',
] as const;

type SecretRow = { id: string } & Record<(typeof SECRET_COLUMNS)[number], string | null>;

const loadRows = async (queryRunner: QueryRunner): Promise<SecretRow[]> =>
  (await queryRunner.query(
    `SELECT id, ${SECRET_COLUMNS.join(', ')} FROM storage_settings ORDER BY id`,
  )) as SecretRow[];

const rewrite = async (
  queryRunner: QueryRunner,
  transform: (value: string) => string | null,
): Promise<void> => {
  for (const row of await loadRows(queryRunner)) {
    const next: Array<string | null> = [];
    let changed = false;
    for (const column of SECRET_COLUMNS) {
      const current = row[column];
      const value = current === null || current === '' ? current : transform(current);
      changed ||= value !== current;
      next.push(value);
    }
    if (changed) {
      await queryRunner.query(
        `UPDATE storage_settings SET ${SECRET_COLUMNS.map((column, index) => `${column} = $${index + 2}`).join(', ')}
          WHERE id = $1`,
        [row.id, ...next],
      );
    }
  }
};

export class StorageSecretsAndOauthState1767225780000 implements MigrationInterface {
  name = 'StorageSecretsAndOauthState1767225780000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
CREATE TABLE storage_oauth_state (
    state_hash    CHAR(64) PRIMARY KEY,
    browser_hash  CHAR(64) NOT NULL,
    user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    provider      VARCHAR(20) NOT NULL CHECK (provider IN ('google_drive', 'onedrive')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ
);
CREATE INDEX idx_storage_oauth_state_expires ON storage_oauth_state (expires_at);
`);
    let key: string | undefined;
    await rewrite(queryRunner, (value) => {
      if (isSealedSecret(value)) {
        return value;
      }
      key ??= resolveDedicatedSecrets(process.env).settingsEncryptionKey;
      return sealSecret(value, key);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    let keys: ReadonlyArray<string> | undefined;
    await rewrite(queryRunner, (value) => {
      if (!isSealedSecret(value)) {
        return value;
      }
      if (!keys) {
        const secrets = resolveDedicatedSecrets(process.env);
        keys = [secrets.settingsEncryptionKey, ...secrets.settingsEncryptionPreviousKeys];
      }
      return openSecret(value, keys).plain;
    });
    await queryRunner.query('DROP TABLE IF EXISTS storage_oauth_state;');
  }
}
