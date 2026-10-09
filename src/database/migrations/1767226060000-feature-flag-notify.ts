import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * La BD es la fuente de verdad de los módulos (feature_flag); la memoria de cada instancia es una caché viva.
 *
 * - feature_flag_notify(): `pg_notify('feature_flags', code)` tras INSERT, UPDATE o DELETE de una fila (con UPDATE que
 *   cambia el código se avisan ambos), y `'*'` tras TRUNCATE. Cada instancia escucha el canal (PgListener) y relee la
 *   fila (o todo con '*'). Así un UPDATE a mano por SQL se ve sin reiniciar y todas las instancias coinciden.
 * - El NOTIFY sale solo si la transacción hace COMMIT. El payload es el código del módulo: nada personal.
 *
 * down(): quita los triggers y la función (la tabla y sus datos no cambian).
 */
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
