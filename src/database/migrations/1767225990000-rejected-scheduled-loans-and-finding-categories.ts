import type { MigrationInterface, QueryRunner } from 'typeorm';

const LABELS: ReadonlyArray<{ readonly code: string; readonly seeded: string; readonly current: string }> = [
  { code: 'AU', seeded: 'En uso', current: 'Activos en uso' },
  { code: 'ANE', seeded: 'No encontrado', current: 'Activos no encontrados' },
  { code: 'AOD', seeded: 'Obsoleto o dañado', current: 'Activos obsoletos dañados' },
];

const CATEGORY_IN_USE = `
  SELECT EXISTS (SELECT 1 FROM physical_inventory_item WHERE finding_category_code = $1)
      OR EXISTS (SELECT 1 FROM inventory_item_correction ic, LATERAL (VALUES (ic.before), (ic.after)) AS c(value)
                 WHERE c.value->>'findingCategory' = $1) AS used`;
export class RejectedScheduledLoansAndFindingCategories1767225990000 implements MigrationInterface {
  name = 'RejectedScheduledLoansAndFindingCategories1767225990000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_request
        DROP CONSTRAINT chk_asset_request_status,
        DROP CONSTRAINT chk_asset_request_accepted,
        DROP CONSTRAINT chk_asset_request_document
    `);
    await queryRunner.query(`
      ALTER TABLE asset_request
        ADD CONSTRAINT chk_asset_request_status CHECK (status IN
          ('REQUESTED', 'ACCEPTED', 'CLOSED_BY_OWNER', 'RETURNED', 'LOAN_SCHEDULED', 'DOCUMENT_GENERATED',
           'CLOSED_LOAN_REJECTED', 'CANCELLED', 'EXPIRED')),
        ADD CONSTRAINT chk_asset_request_accepted CHECK (
          status NOT IN ('ACCEPTED', 'LOAN_SCHEDULED', 'DOCUMENT_GENERATED', 'CLOSED_LOAN_REJECTED', 'EXPIRED')
          OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
        ADD CONSTRAINT chk_asset_request_document CHECK (
          (status NOT IN ('LOAN_SCHEDULED', 'CLOSED_LOAN_REJECTED')
            OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL))
          AND (status <> 'DOCUMENT_GENERATED'
            OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL)
            OR (kind = 'PERMANENT' AND transfer_id IS NOT NULL AND loan_id IS NULL)))
    `);

    const [ani] = (await queryRunner.query(CATEGORY_IN_USE, ['ANI'])) as Array<{ used: boolean }>;
    if (ani?.used) {
      await queryRunner.query(`UPDATE inventory_finding_category SET is_active = FALSE, updated_at = NOW() WHERE code = 'ANI'`);
    } else {
      await queryRunner.query(`DELETE FROM inventory_finding_category WHERE code = 'ANI'`);
    }
    await queryRunner.query(
      'UPDATE inventory_finding_category SET pending_definition = FALSE, updated_at = NOW() WHERE pending_definition',
    );
    for (const label of LABELS) {
      await queryRunner.query(
        'UPDATE inventory_finding_category SET label = $3, updated_at = NOW() WHERE code = $1 AND label = $2',
        [label.code, label.seeded, label.current],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT count(*)::int AS total FROM asset_request WHERE status = 'CLOSED_LOAN_REJECTED'`,
    )) as Array<{ total: number }>;
    if ((row?.total ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin perder datos: hay ${row?.total} solicitudes cerradas por rechazo de su préstamo (CLOSED_LOAN_REJECTED)`,
      );
    }
    for (const label of LABELS) {
      await queryRunner.query(
        'UPDATE inventory_finding_category SET label = $2, updated_at = NOW() WHERE code = $1 AND label = $3',
        [label.code, label.seeded, label.current],
      );
    }
    await queryRunner.query(`
      INSERT INTO inventory_finding_category
        (code, label, description, is_active, sort_order, suggest_results, suggest_conditions, pending_definition)
      VALUES ('ANI', 'ANI', NULL, FALSE, 40, NULL, NULL, TRUE)
      ON CONFLICT (code) DO UPDATE SET is_active = FALSE, pending_definition = TRUE, updated_at = NOW()
    `);
    await queryRunner.query(`
      ALTER TABLE asset_request
        DROP CONSTRAINT chk_asset_request_status,
        DROP CONSTRAINT chk_asset_request_accepted,
        DROP CONSTRAINT chk_asset_request_document
    `);
    await queryRunner.query(`
      ALTER TABLE asset_request
        ADD CONSTRAINT chk_asset_request_status CHECK (status IN
          ('REQUESTED', 'ACCEPTED', 'CLOSED_BY_OWNER', 'RETURNED', 'LOAN_SCHEDULED', 'DOCUMENT_GENERATED', 'CANCELLED', 'EXPIRED')),
        ADD CONSTRAINT chk_asset_request_accepted CHECK (
          status NOT IN ('ACCEPTED', 'LOAN_SCHEDULED', 'DOCUMENT_GENERATED', 'EXPIRED') OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
        ADD CONSTRAINT chk_asset_request_document CHECK (
          (status <> 'LOAN_SCHEDULED' OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL))
          AND (status <> 'DOCUMENT_GENERATED'
            OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL)
            OR (kind = 'PERMANENT' AND transfer_id IS NOT NULL AND loan_id IS NULL)))
    `);
  }
}
