import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hallazgos, causas de faltante y correcciones de la toma física.
 *
 * - inventory_finding_category: catálogo configurable de categorías de hallazgo (código corto como PK). La sugerencia
 *   sale de los datos (suggest_results / suggest_conditions), nunca de los códigos. Siembra AU, ANE, AOD y ANI; ANI
 *   queda inactiva y pending_definition = TRUE porque nadie ha definido qué significa.
 * - inventory_missing_cause: catálogo de causas de faltante, vacío (Control Interno lo llena a partir de los textos de
 *   "Otra").
 * - physical_inventory_item: finding_category_code, missing_cause_id / missing_cause_other (CHECK: un MISSING lleva
 *   exactamente uno; los demás resultados, ninguno), expected_code_temporary (el activo tenía la marca BARCODE_TEMP al
 *   congelar la foto; NULL en fotos anteriores), was_lost (sobrante de un activo que estaba LOST), voided_at (sobrante
 *   anulado por error).
 *   El CHECK se crea NOT VALID (las filas MISSING anteriores no tienen causa) y se valida en la misma migración solo si
 *   ninguna fila lo viola.
 * - inventory_item_correction: historial de correcciones y anulaciones (antes/después en JSONB, motivo, quién, cuándo).
 * - Permiso inventory_catalog:manage:global ("Catálogos de toma física") para INTERNAL_CONTROL_DIRECTOR y SUPER_ADMIN.
 *
 * down(): se niega si hay datos que se perderían (causas, correcciones, categorías asignadas, causas en ítems,
 * sobrantes anulados o de activos perdidos, ítems NOT_VERIFIED). No borra ni convierte datos por su cuenta.
 */

const PERMISSION_CODE = 'inventory_catalog:manage:global';

export class InventoryFindingsAndCorrections1767225870000 implements MigrationInterface {
  name = 'InventoryFindingsAndCorrections1767225870000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_finding_category (
        code               VARCHAR(10) PRIMARY KEY,
        label              VARCHAR(80) NOT NULL,
        description        TEXT,
        is_active          BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order         SMALLINT NOT NULL DEFAULT 0,
        suggest_results    TEXT[],
        suggest_conditions TEXT[],
        pending_definition BOOLEAN NOT NULL DEFAULT FALSE,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_inventory_finding_category_code CHECK (code ~ '^[A-Z0-9_]{1,10}$'),
        CONSTRAINT chk_inventory_finding_category_results
          CHECK (suggest_results IS NULL OR suggest_results <@ ARRAY['FOUND', 'MISSING', 'MISPLACED', 'SURPLUS']::TEXT[]),
        CONSTRAINT chk_inventory_finding_category_conditions
          CHECK (suggest_conditions IS NULL
            OR suggest_conditions <@ ARRAY['NEW', 'GOOD', 'FAIR', 'POOR', 'OBSOLETE']::TEXT[])
      )
    `);
    await queryRunner.query(`
      INSERT INTO inventory_finding_category
        (code, label, description, is_active, sort_order, suggest_results, suggest_conditions, pending_definition)
      VALUES
        ('AU', 'En uso', NULL, TRUE, 10, ARRAY['FOUND', 'MISPLACED'], NULL, FALSE),
        ('ANE', 'No encontrado', NULL, TRUE, 20, ARRAY['MISSING'], NULL, FALSE),
        ('AOD', 'Obsoleto o dañado', NULL, TRUE, 30, NULL, ARRAY['OBSOLETE', 'POOR'], FALSE),
        ('ANI', 'ANI', NULL, FALSE, 40, NULL, NULL, TRUE)
    `);

    await queryRunner.query(`
      CREATE TABLE inventory_missing_cause (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label      VARCHAR(120) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_inventory_missing_cause_label CHECK (length(btrim(label)) >= 3)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_inventory_missing_cause_label ON inventory_missing_cause (lower(btrim(label)))`,
    );

    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        ADD COLUMN finding_category_code   VARCHAR(10) REFERENCES inventory_finding_category(code),
        ADD COLUMN missing_cause_id        UUID REFERENCES inventory_missing_cause(id),
        ADD COLUMN missing_cause_other     TEXT,
        ADD COLUMN expected_code_temporary BOOLEAN,
        ADD COLUMN was_lost                BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN voided_at               TIMESTAMPTZ,
        ADD CONSTRAINT chk_inv_item_missing_cause_other
          CHECK (missing_cause_other IS NULL OR length(btrim(missing_cause_other)) BETWEEN 3 AND 500),
        ADD CONSTRAINT chk_inv_item_voided_surplus
          CHECK (voided_at IS NULL OR verification_result = 'SURPLUS')
    `);
    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        ADD CONSTRAINT chk_inv_item_missing_cause CHECK (
          CASE WHEN verification_result = 'MISSING'
            THEN num_nonnulls(missing_cause_id, missing_cause_other) = 1
            ELSE num_nonnulls(missing_cause_id, missing_cause_other) = 0
          END
        ) NOT VALID
    `);
    const [violations] = (await queryRunner.query(`
      SELECT count(*)::int AS count FROM physical_inventory_item
      WHERE NOT CASE WHEN verification_result = 'MISSING'
        THEN num_nonnulls(missing_cause_id, missing_cause_other) = 1
        ELSE num_nonnulls(missing_cause_id, missing_cause_other) = 0
      END
    `)) as Array<{ count: number }>;
    if ((violations?.count ?? 0) === 0) {
      await queryRunner.query(`ALTER TABLE physical_inventory_item VALIDATE CONSTRAINT chk_inv_item_missing_cause`);
    }
    await queryRunner.query(
      `CREATE INDEX idx_inv_item_missing_other ON physical_inventory_item (lower(btrim(missing_cause_other)))
       WHERE missing_cause_other IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE inventory_item_correction (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id      UUID NOT NULL REFERENCES physical_inventory_item(id) ON DELETE CASCADE,
        inventory_id UUID NOT NULL REFERENCES physical_inventory(id) ON DELETE CASCADE,
        kind         VARCHAR(10) NOT NULL,
        before       JSONB NOT NULL,
        after        JSONB NOT NULL,
        reason       TEXT NOT NULL,
        corrected_by UUID NOT NULL REFERENCES app_user(id),
        corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_inventory_item_correction_kind CHECK (kind IN ('CORRECT', 'VOID')),
        CONSTRAINT chk_inventory_item_correction_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 500)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_inventory_item_correction_item ON inventory_item_correction (item_id, corrected_at)`,
    );

    await queryRunner.query(
      `
      INSERT INTO permission
        (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES
        ($1, 'INVENTORY', 'inventory_catalog', 'Catálogos de toma física', 'manage', 'GLOBAL',
         'Administrar las categorías de hallazgo y las causas de faltante de la toma física', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [PERMISSION_CODE],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = $1
      WHERE r.code IN ('INTERNAL_CONTROL_DIRECTOR', 'SUPER_ADMIN')
      ON CONFLICT DO NOTHING
    `,
      [PERMISSION_CODE],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM inventory_missing_cause)::int AS causes,
             (SELECT count(*) FROM inventory_item_correction)::int AS corrections,
             (SELECT count(*) FROM physical_inventory_item
               WHERE finding_category_code IS NOT NULL OR missing_cause_id IS NOT NULL
                 OR missing_cause_other IS NOT NULL OR was_lost OR voided_at IS NOT NULL
                 OR verification_result = 'NOT_VERIFIED')::int AS items
    `)) as Array<{ causes: number; corrections: number; items: number }>;
    if (row && (row.causes > 0 || row.corrections > 0 || row.items > 0)) {
      throw new Error(
        `No se puede revertir hallazgos y correcciones de la toma sin perder datos: ${row.causes} causas de faltante, ` +
          `${row.corrections} correcciones y ${row.items} ítems con categoría, causa, sobrante anulado o de activo ` +
          'perdido, o NOT_VERIFIED. Revíselos y bórrelos a mano antes de revertir.',
      );
    }

    await queryRunner.query(
      `DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = $1)`,
      [PERMISSION_CODE],
    );
    await queryRunner.query(`DELETE FROM permission WHERE code = $1`, [PERMISSION_CODE]);

    await queryRunner.query(`DROP TABLE IF EXISTS inventory_item_correction`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_inv_item_missing_other`);
    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        DROP CONSTRAINT IF EXISTS chk_inv_item_missing_cause,
        DROP CONSTRAINT IF EXISTS chk_inv_item_voided_surplus,
        DROP CONSTRAINT IF EXISTS chk_inv_item_missing_cause_other,
        DROP COLUMN IF EXISTS voided_at,
        DROP COLUMN IF EXISTS was_lost,
        DROP COLUMN IF EXISTS expected_code_temporary,
        DROP COLUMN IF EXISTS missing_cause_other,
        DROP COLUMN IF EXISTS missing_cause_id,
        DROP COLUMN IF EXISTS finding_category_code
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS inventory_missing_cause`);
    await queryRunner.query(`DROP TABLE IF EXISTS inventory_finding_category`);
  }
}
