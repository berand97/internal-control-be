import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FeatureFlagNotify1767226060000 implements MigrationInterface {
  name = 'FeatureFlagNotify1767226060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION feature_flag_notify() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          PERFORM pg_notify('feature_flags', '*');
          RETURN NULL;
        END IF;
        IF TG_OP = 'DELETE' THEN
          PERFORM pg_notify('feature_flags', OLD.code);
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.code <> NEW.code THEN
          PERFORM pg_notify('feature_flags', OLD.code);
        END IF;
        PERFORM pg_notify('feature_flags', NEW.code);
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER feature_flag_notify_row
      AFTER INSERT OR UPDATE OR DELETE ON feature_flag
      FOR EACH ROW EXECUTE FUNCTION feature_flag_notify()
    `);
    await queryRunner.query(`
      CREATE TRIGGER feature_flag_notify_truncate
      AFTER TRUNCATE ON feature_flag
      FOR EACH STATEMENT EXECUTE FUNCTION feature_flag_notify()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER feature_flag_notify_truncate ON feature_flag');
    await queryRunner.query('DROP TRIGGER feature_flag_notify_row ON feature_flag');
    await queryRunner.query('DROP FUNCTION feature_flag_notify()');
  }
}
