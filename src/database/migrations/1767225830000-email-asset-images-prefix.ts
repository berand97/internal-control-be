import type { MigrationInterface, QueryRunner } from 'typeorm';

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
