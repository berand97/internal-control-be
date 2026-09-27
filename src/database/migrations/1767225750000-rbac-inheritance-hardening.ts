import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Herencia de roles (parent_role_id) sin atajos (hallazgos BE-02 y BE-03).
 *
 * - v_user_effective_permissions ignora los roles borrados (deleted_at): un rol borrado no aporta permisos ni
 *   directamente ni como ancestro de otro rol. Mismas columnas que la vista de 1767225601000.
 * - fn_role_lineage(rol): el rol y sus ancestros vivos por parent_role_id (UNION: termina aunque hubiera ciclo).
 * - fn_check_sod_violation evalúa la separación de funciones ESTÁTICA sobre los roles efectivos (con herencia) del
 *   usuario, no solo sobre los directos. Mismo mensaje, que la aplicación reconoce (isSodViolation).
 * - trg_role_sod_inheritance: al crear un rol o cambiar su parent_role_id, rechaza que el linaje del rol reúna los
 *   dos lados de una regla y que algún titular del rol o de sus herederos quede en conflicto.
 */
export class RbacInheritanceHardening1767225750000 implements MigrationInterface {
  name = 'RbacInheritanceHardening1767225750000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE VIEW v_user_effective_permissions AS
      WITH RECURSIVE role_hierarchy AS (
          SELECT
              ur.user_id,
              ur.role_id,
              r.code AS role_code,
              ur.scope_type,
              ur.scope_id,
              ur.valid_from,
              ur.valid_until,
              ur.is_delegated
          FROM user_role ur
          JOIN role r ON r.id = ur.role_id
          WHERE ur.revoked_at IS NULL
            AND ur.valid_from <= NOW()
            AND (ur.valid_until IS NULL OR ur.valid_until > NOW())
            AND r.deleted_at IS NULL

          UNION

          SELECT
              rh.user_id,
              r.parent_role_id AS role_id,
              pr.code AS role_code,
              rh.scope_type,
              rh.scope_id,
              rh.valid_from,
              rh.valid_until,
              rh.is_delegated
          FROM role_hierarchy rh
          JOIN role r  ON r.id = rh.role_id
          JOIN role pr ON pr.id = r.parent_role_id
          WHERE r.parent_role_id IS NOT NULL
            AND pr.deleted_at IS NULL
      )
      SELECT DISTINCT
          rh.user_id,
          p.id            AS permission_id,
          p.code          AS permission_code,
          p.module,
          p.resource_type,
          p.action,
          p.scope_level,
          rh.scope_type   AS user_scope_type,
          rh.scope_id     AS user_scope_id,
          rp.conditions,
          rh.is_delegated,
          rh.valid_until
      FROM role_hierarchy rh
      JOIN role_permission rp ON rp.role_id = rh.role_id
      JOIN permission p       ON p.id = rp.permission_id
    `);

    await queryRunner.query(`
      CREATE FUNCTION fn_role_lineage(p_role_id UUID)
      RETURNS TABLE (role_id UUID)
      LANGUAGE sql STABLE AS $$
        WITH RECURSIVE lineage(id) AS (
          SELECT r.id FROM role r WHERE r.id = p_role_id AND r.deleted_at IS NULL
          UNION
          SELECT pr.id
          FROM lineage l
          JOIN role r  ON r.id = l.id
          JOIN role pr ON pr.id = r.parent_role_id
          WHERE pr.deleted_at IS NULL
        )
        SELECT id FROM lineage
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION fn_user_effective_role_ids(p_user_id UUID)
      RETURNS TABLE (role_id UUID)
      LANGUAGE sql STABLE AS $$
        SELECT DISTINCT l.role_id
        FROM user_role ur
        CROSS JOIN LATERAL fn_role_lineage(ur.role_id) l
        WHERE ur.user_id = p_user_id
          AND ur.revoked_at IS NULL
      $$
    `);

    // Mismo nombre y firma: trg_check_sod (BEFORE INSERT OR UPDATE ON user_role) la sigue usando.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_check_sod_violation()
      RETURNS TRIGGER AS $$
      DECLARE
          v_new_role UUID;
          v_conflict_role UUID;
      BEGIN
          IF NEW.revoked_at IS NOT NULL THEN
              RETURN NEW;
          END IF;

          SELECT
              CASE WHEN n_a.role_id IS NOT NULL THEN sod.role_a_id ELSE sod.role_b_id END,
              CASE WHEN n_a.role_id IS NOT NULL THEN sod.role_b_id ELSE sod.role_a_id END
          INTO v_new_role, v_conflict_role
          FROM role_separation_of_duties sod
          LEFT JOIN fn_role_lineage(NEW.role_id) n_a ON n_a.role_id = sod.role_a_id
          LEFT JOIN fn_role_lineage(NEW.role_id) n_b ON n_b.role_id = sod.role_b_id
          WHERE sod.constraint_type = 'STATIC'
            AND (n_a.role_id IS NOT NULL OR n_b.role_id IS NOT NULL)
            AND (
                -- el propio linaje del rol reúne los dos lados
                (n_a.role_id IS NOT NULL AND n_b.role_id IS NOT NULL)
                -- o el otro lado ya lo tiene el usuario por otra asignación activa (directa o heredada)
                OR EXISTS (
                    SELECT 1
                    FROM user_role ur
                    CROSS JOIN LATERAL fn_role_lineage(ur.role_id) e
                    WHERE ur.user_id = NEW.user_id
                      AND ur.revoked_at IS NULL
                      AND ur.id IS DISTINCT FROM NEW.id
                      AND e.role_id = CASE WHEN n_a.role_id IS NOT NULL THEN sod.role_b_id ELSE sod.role_a_id END
                )
            )
          LIMIT 1;

          IF v_conflict_role IS NOT NULL THEN
              RAISE EXCEPTION 'Violación de Separación de Funciones: rol % conflictúa con rol % ya asignado al usuario', v_new_role, v_conflict_role;
          END IF;

          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE FUNCTION fn_check_role_inheritance_sod()
      RETURNS TRIGGER AS $$
      DECLARE
          v_role_a UUID;
          v_role_b UUID;
          v_user UUID;
      BEGIN
          IF NEW.parent_role_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
              RETURN NULL;
          END IF;

          -- 1) El linaje del rol no puede reunir los dos lados de una regla estática.
          SELECT sod.role_a_id, sod.role_b_id INTO v_role_a, v_role_b
          FROM role_separation_of_duties sod
          JOIN fn_role_lineage(NEW.id) a ON a.role_id = sod.role_a_id
          JOIN fn_role_lineage(NEW.id) b ON b.role_id = sod.role_b_id
          WHERE sod.constraint_type = 'STATIC'
          LIMIT 1;
          IF v_role_a IS NOT NULL THEN
              RAISE EXCEPTION 'Violación de Separación de Funciones: la herencia del rol % reúne los roles % y %', NEW.code, v_role_a, v_role_b;
          END IF;

          -- 2) Ningún titular del rol o de un rol que lo herede puede quedar con ambos lados de una regla estática,
          --    con al menos uno de ellos llegado por el linaje nuevo.
          SELECT holders.user_id, sod.role_a_id, sod.role_b_id INTO v_user, v_role_a, v_role_b
          FROM (
              SELECT DISTINCT ur.user_id
              FROM user_role ur
              CROSS JOIN LATERAL fn_role_lineage(ur.role_id) l
              WHERE ur.revoked_at IS NULL
                AND l.role_id = NEW.id
          ) holders
          CROSS JOIN role_separation_of_duties sod
          WHERE sod.constraint_type = 'STATIC'
            AND (sod.role_a_id IN (SELECT role_id FROM fn_role_lineage(NEW.id))
                 OR sod.role_b_id IN (SELECT role_id FROM fn_role_lineage(NEW.id)))
            AND sod.role_a_id IN (SELECT role_id FROM fn_user_effective_role_ids(holders.user_id))
            AND sod.role_b_id IN (SELECT role_id FROM fn_user_effective_role_ids(holders.user_id))
          LIMIT 1;
          IF v_user IS NOT NULL THEN
              RAISE EXCEPTION 'Violación de Separación de Funciones: con la herencia del rol % un titular reúne los roles % y %', NEW.code, v_role_a, v_role_b;
          END IF;

          RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    // AFTER: el linaje ya ve la fila nueva o el padre nuevo. El error aborta la sentencia igual que BEFORE.
    await queryRunner.query(`
      CREATE TRIGGER trg_role_sod_inheritance
          AFTER INSERT OR UPDATE OF parent_role_id ON role
          FOR EACH ROW EXECUTE FUNCTION fn_check_role_inheritance_sod()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS trg_role_sod_inheritance ON role');
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_check_role_inheritance_sod()');

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_check_sod_violation()
      RETURNS TRIGGER AS $$
      DECLARE
          v_conflict_role UUID;
      BEGIN
          IF NEW.revoked_at IS NOT NULL THEN
              RETURN NEW;
          END IF;

          SELECT sod.role_b_id INTO v_conflict_role
          FROM role_separation_of_duties sod
          JOIN user_role ur ON ur.role_id = sod.role_b_id
          WHERE sod.role_a_id = NEW.role_id
            AND ur.user_id = NEW.user_id
            AND ur.revoked_at IS NULL
            AND sod.constraint_type = 'STATIC'
          LIMIT 1;

          IF v_conflict_role IS NOT NULL THEN
              RAISE EXCEPTION 'Violación de Separación de Funciones: rol % conflictúa con rol % ya asignado al usuario', NEW.role_id, v_conflict_role;
          END IF;

          SELECT sod.role_a_id INTO v_conflict_role
          FROM role_separation_of_duties sod
          JOIN user_role ur ON ur.role_id = sod.role_a_id
          WHERE sod.role_b_id = NEW.role_id
            AND ur.user_id = NEW.user_id
            AND ur.revoked_at IS NULL
            AND sod.constraint_type = 'STATIC'
          LIMIT 1;

          IF v_conflict_role IS NOT NULL THEN
              RAISE EXCEPTION 'Violación de Separación de Funciones: rol % conflictúa con rol % ya asignado al usuario', NEW.role_id, v_conflict_role;
          END IF;

          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query('DROP FUNCTION IF EXISTS fn_user_effective_role_ids(UUID)');
    await queryRunner.query('DROP FUNCTION IF EXISTS fn_role_lineage(UUID)');

    await queryRunner.query(`
      CREATE OR REPLACE VIEW v_user_effective_permissions AS
      WITH RECURSIVE role_hierarchy AS (
          SELECT
              ur.user_id,
              ur.role_id,
              r.code AS role_code,
              ur.scope_type,
              ur.scope_id,
              ur.valid_from,
              ur.valid_until,
              ur.is_delegated
          FROM user_role ur
          JOIN role r ON r.id = ur.role_id
          WHERE ur.revoked_at IS NULL
            AND ur.valid_from <= NOW()
            AND (ur.valid_until IS NULL OR ur.valid_until > NOW())

          UNION

          SELECT
              rh.user_id,
              r.parent_role_id AS role_id,
              pr.code AS role_code,
              rh.scope_type,
              rh.scope_id,
              rh.valid_from,
              rh.valid_until,
              rh.is_delegated
          FROM role_hierarchy rh
          JOIN role r  ON r.id = rh.role_id
          JOIN role pr ON pr.id = r.parent_role_id
          WHERE r.parent_role_id IS NOT NULL
      )
      SELECT DISTINCT
          rh.user_id,
          p.id            AS permission_id,
          p.code          AS permission_code,
          p.module,
          p.resource_type,
          p.action,
          p.scope_level,
          rh.scope_type   AS user_scope_type,
          rh.scope_id     AS user_scope_id,
          rp.conditions,
          rh.is_delegated,
          rh.valid_until
      FROM role_hierarchy rh
      JOIN role_permission rp ON rp.role_id = rh.role_id
      JOIN permission p       ON p.id = rp.permission_id
    `);
  }
}
