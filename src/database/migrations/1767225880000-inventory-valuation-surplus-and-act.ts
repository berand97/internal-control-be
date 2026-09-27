import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corte contable, sobrantes que se vuelven activo y acta OCI-21-37 de la toma física.
 *
 * - accounting_cut: un corte contable (fecha y fuente) contra el que se concilia una toma. source_kind MANUAL (se
 *   registra la fecha y la fuente) o IMPORT (con staging_import_id; el destino del importador aún no existe: las
 *   columnas del reporte de Contabilidad no están definidas).
 * - accounting_cut_line: una fila del corte (identificador del activo tal como vino, activo resuelto, valor en libros,
 *   precio de compra, centro de costo, fila cruda). Un activo aparece a lo sumo una vez por corte.
 * - physical_inventory: accounting_cut_id (corte asociado), snapshot_taken_at (instante de la foto al iniciar; NULL
 *   en tomas iniciadas antes), act_request_id / act_document_id (solicitud y acta OCI-21-37) y act_blocked_* (por
 *   qué el acta no se encoló al aprobar la conciliación).
 * - physical_inventory_item: resolución del sobrante sin activo (CREATE_ASSET con resolved_asset_id, o
 *   LEAVE_UNRESOLVED con su motivo), quién y cuándo.
 *
 * down(): se niega si hay datos que se perderían (cortes, tomas con corte o acta, sobrantes resueltos).
 */
export class InventoryValuationSurplusAndAct1767225880000 implements MigrationInterface {
  name = 'InventoryValuationSurplusAndAct1767225880000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE accounting_cut (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cut_date          DATE NOT NULL,
        source_label      VARCHAR(200) NOT NULL,
        source_kind       VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
        staging_import_id UUID REFERENCES staging_import(id),
        notes             TEXT,
        created_by        UUID NOT NULL REFERENCES app_user(id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_accounting_cut_source_label CHECK (length(btrim(source_label)) >= 3),
        CONSTRAINT chk_accounting_cut_source_kind CHECK (source_kind IN ('MANUAL', 'IMPORT')),
        CONSTRAINT chk_accounting_cut_import CHECK ((source_kind = 'IMPORT') = (staging_import_id IS NOT NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_accounting_cut_date ON accounting_cut (cut_date DESC)`);

    await queryRunner.query(`
      CREATE TABLE accounting_cut_line (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cut_id            UUID NOT NULL REFERENCES accounting_cut(id) ON DELETE CASCADE,
        line_number       INTEGER,
        asset_ref         VARCHAR(100) NOT NULL,
        asset_id          UUID REFERENCES asset(id),
        book_value        NUMERIC(15,2),
        acquisition_price NUMERIC(15,2),
        cost_center_code  VARCHAR(30),
        raw               JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_accounting_cut_line_cut ON accounting_cut_line (cut_id)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_accounting_cut_line_asset ON accounting_cut_line (cut_id, asset_id) WHERE asset_id IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN accounting_cut_id   UUID REFERENCES accounting_cut(id),
        ADD COLUMN snapshot_taken_at   TIMESTAMPTZ,
        ADD COLUMN act_request_id      UUID REFERENCES document_request(id),
        ADD COLUMN act_document_id     UUID REFERENCES document(id),
        ADD COLUMN act_blocked_code    VARCHAR(40),
        ADD COLUMN act_blocked_message TEXT,
        ADD COLUMN act_blocked_at      TIMESTAMPTZ
    `);

    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        ADD COLUMN surplus_resolution        VARCHAR(20),
        ADD COLUMN surplus_resolution_reason TEXT,
        ADD COLUMN resolved_asset_id         UUID REFERENCES asset(id),
        ADD COLUMN resolved_at               TIMESTAMPTZ,
        ADD COLUMN resolved_by               UUID REFERENCES app_user(id),
        ADD CONSTRAINT chk_inv_item_surplus_resolution
          CHECK (surplus_resolution IS NULL
            OR (surplus_resolution IN ('CREATE_ASSET', 'LEAVE_UNRESOLVED') AND verification_result = 'SURPLUS'
                AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),
        ADD CONSTRAINT chk_inv_item_resolved_asset
          CHECK ((surplus_resolution IS NOT DISTINCT FROM 'CREATE_ASSET') = (resolved_asset_id IS NOT NULL))
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_inv_item_resolved_asset ON physical_inventory_item (resolved_asset_id)
       WHERE resolved_asset_id IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM accounting_cut)::int AS cuts,
             (SELECT count(*) FROM physical_inventory
               WHERE accounting_cut_id IS NOT NULL OR act_request_id IS NOT NULL OR act_document_id IS NOT NULL
                 OR act_blocked_code IS NOT NULL)::int AS inventories,
             (SELECT count(*) FROM physical_inventory_item WHERE surplus_resolution IS NOT NULL)::int AS items
    `)) as Array<{ cuts: number; inventories: number; items: number }>;
    if (row && (row.cuts > 0 || row.inventories > 0 || row.items > 0)) {
      throw new Error(
        `No se puede revertir corte contable, sobrantes y acta de la toma sin perder datos: ${row.cuts} cortes, ` +
          `${row.inventories} tomas con corte o acta y ${row.items} sobrantes resueltos. Revíselos y bórrelos a mano ` +
          'antes de revertir.',
      );
    }
    await queryRunner.query(`DROP INDEX IF EXISTS uq_inv_item_resolved_asset`);
    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        DROP CONSTRAINT IF EXISTS chk_inv_item_resolved_asset,
        DROP CONSTRAINT IF EXISTS chk_inv_item_surplus_resolution,
        DROP COLUMN IF EXISTS resolved_by,
        DROP COLUMN IF EXISTS resolved_at,
        DROP COLUMN IF EXISTS resolved_asset_id,
        DROP COLUMN IF EXISTS surplus_resolution_reason,
        DROP COLUMN IF EXISTS surplus_resolution
    `);
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        DROP COLUMN IF EXISTS act_blocked_at,
        DROP COLUMN IF EXISTS act_blocked_message,
        DROP COLUMN IF EXISTS act_blocked_code,
        DROP COLUMN IF EXISTS act_document_id,
        DROP COLUMN IF EXISTS act_request_id,
        DROP COLUMN IF EXISTS snapshot_taken_at,
        DROP COLUMN IF EXISTS accounting_cut_id
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS accounting_cut_line`);
    await queryRunner.query(`DROP TABLE IF EXISTS accounting_cut`);
  }
}
