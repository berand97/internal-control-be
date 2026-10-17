import type { MigrationInterface, QueryRunner } from 'typeorm';


export class PersonEmailSingleLine1767225760000 implements MigrationInterface {
  name = 'PersonEmailSingleLine1767225760000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
ALTER TABLE person DROP CONSTRAINT IF EXISTS chk_person_email_single_line;
ALTER TABLE person ADD CONSTRAINT chk_person_email_single_line
    CHECK (email !~ '[[:cntrl:]]') NOT VALID;
`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE person DROP CONSTRAINT IF EXISTS chk_person_email_single_line;');
  }
}
