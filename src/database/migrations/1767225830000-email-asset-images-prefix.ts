import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Imágenes de correo bajo images/email/ (organización del almacenamiento, src/shared/storage/storage-keys.ts).
 *
 * up(): el CHECK chk_email_asset_storage_key acepta la clave nueva `images/email/<uuid>.<png|jpg>` y sigue aceptando
 * la anterior `email-assets/<uuid>.<png|jpg>`. Las filas existentes no se tocan (ni storage_key ni public_url): sus
 * objetos no se mueven y los correos ya enviados siguen apuntando a ellos.
 *
 * down(): restaura el CHECK original (solo email-assets/). Si ya hay filas con clave images/email/ el CHECK original
 * no se puede crear sin perder la referencia a esos objetos, así que down() FALLA con un mensaje que dice cuántas
 * filas son; no reescribe ni borra nada. Para revertir de todos modos habría que decidir antes qué hacer con esas
 * imágenes (y con los correos que las usan).
 *
 * TypeORM corre cada migración en una transacción (CLI: 'all'; tests: 'each'): el DROP y el ADD van juntos.
 */
const NEW_KEY = `'^images/email/[0-9a-f-]{36}[.](png|jpg)$'`;
const OLD_KEY = `'^email-assets/[0-9a-f-]{36}[.](png|jpg)$'`;

export class EmailAssetImagesPrefix1767225830000 implements MigrationInterface {
  name = 'EmailAssetImagesPrefix1767225830000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE email_asset
        DROP CONSTRAINT chk_email_asset_storage_key,
        ADD CONSTRAINT chk_email_asset_storage_key CHECK (storage_key ~ ${NEW_KEY} OR storage_key ~ ${OLD_KEY})
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT count(*)::int AS total FROM email_asset WHERE NOT (storage_key ~ ${OLD_KEY})`,
    )) as Array<{ total: number }>;
    const total = row?.total ?? 0;
    if (total > 0) {
      throw new Error(
        `No se puede revertir 1767225830000: ${total} imagen(es) de correo usan claves images/email/ que el CHECK ` +
          'original (solo email-assets/) no admite. No se reescriben ni se borran; decida primero qué hacer con ellas.',
      );
    }
    await queryRunner.query(`
      ALTER TABLE email_asset
        DROP CONSTRAINT chk_email_asset_storage_key,
        ADD CONSTRAINT chk_email_asset_storage_key CHECK (storage_key ~ ${OLD_KEY})
    `);
  }
}
