import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PersonEmailUnacRequired1767225603000 implements MigrationInterface {
  name = 'PersonEmailUnacRequired1767225603000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
ALTER TABLE person ALTER COLUMN email SET NOT NULL;
ALTER TABLE person ADD CONSTRAINT chk_person_email_unac
    CHECK (email ~* '@unac\\.edu\\.co$');
`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
ALTER TABLE person DROP CONSTRAINT IF EXISTS chk_person_email_unac;
ALTER TABLE person ALTER COLUMN email DROP NOT NULL;
`);
  }
}
