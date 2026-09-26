import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Préstamos gobernados por las firmas del acta y entregas cancelables (decisiones en docs/decisiones.md):
 *
 * - loan_status gana PENDING_SIGNATURES (entregado físicamente, acta OCI-01-65 sin todas sus firmas) y
 *   CLOSED_WITH_LOSSES (todos los activos resueltos, alguno perdido). El tipo se recrea en vez de
 *   ALTER TYPE … ADD VALUE para poder usar los valores nuevos en esta misma transacción (reclasificación) y para
 *   que down() pueda quitarlos. Dependientes del tipo (pg_depend): la columna asset_loan.status y su DEFAULT,
 *   el índice parcial idx_loan_expected_return y la vista v_overdue_loans; se recrean idénticos.
 * - Reclasificación: un préstamo ACTIVE/OVERDUE cuya acta OCI-01-65 existe (solicitud o documento) y no está
 *   firmada pasa a PENDING_SIGNATURES. Sin acta (entregas anteriores al motor) se quedan como están: no hay
 *   firmas que esperar. down() devuelve PENDING_SIGNATURES → ACTIVE (lo que habrían sido con la regla anterior)
 *   y CLOSED_WITH_LOSSES → PARTIALLY_RETURNED (la regla anterior: LOST contaba como no devuelto).
 * - asset_loan_item.received_at: cuándo se recibió (receive-return) la devolución del activo, para distinguir los
 *   activos resueltos de los que siguen fuera en un préstamo PARTIALLY_RETURNED. Se rellena con el movimiento
 *   RETURN del activo en ese préstamo (metadata.loanId).
 * - asset_handover: estado CANCELLED con motivo y quién (cancelación antes de SIGNED).
 */
export class LoanSignaturesAndHandoverCancel1767225690000 implements MigrationInterface {
  name = 'LoanSignaturesAndHandoverCancel1767225690000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.recreateLoanStatus(queryRunner, [
      'REQUESTED',
      'APPROVED',
      'REJECTED',
      'ACTIVE',
      'RETURNED',
      'OVERDUE',
      'CANCELLED',
      'IN_TRANSIT',
      'PENDING_RECEPTION',
      'PARTIALLY_RETURNED',
      'PENDING_SIGNATURES',
      'CLOSED_WITH_LOSSES',
    ]);
    await queryRunner.query(`
      UPDATE asset_loan l SET status = 'PENDING_SIGNATURES', updated_at = NOW()
      WHERE l.status IN ('ACTIVE', 'OVERDUE')
        AND (
          EXISTS (SELECT 1 FROM document_request r
                  WHERE r.format_key = 'OCI-01-65' AND r.payload->>'entityType' = 'LOAN'
                    AND r.payload->>'entityId' = l.id::text AND r.status <> 'CANCELLED')
          OR EXISTS (SELECT 1 FROM document d
                     WHERE d.format_key = 'OCI-01-65' AND d.entity_type = 'LOAN' AND d.entity_id = l.id)
        )
        AND NOT EXISTS (SELECT 1 FROM document d
                        WHERE d.format_key = 'OCI-01-65' AND d.entity_type = 'LOAN' AND d.entity_id = l.id
                          AND d.status = 'SIGNED')
    `);

    await queryRunner.query('ALTER TABLE asset_loan_item ADD COLUMN received_at TIMESTAMPTZ');
    await queryRunner.query(`
      UPDATE asset_loan_item i SET received_at = m.created_at
      FROM asset_movement m
      WHERE m.asset_id = i.asset_id AND m.movement_type = 'RETURN' AND m.metadata->>'loanId' = i.loan_id::text
    `);

    await queryRunner.query(`
      ALTER TABLE asset_handover
        ADD COLUMN cancelled_by UUID REFERENCES app_user(id),
        ADD COLUMN cancel_reason TEXT,
        DROP CONSTRAINT chk_asset_handover_status,
        DROP CONSTRAINT chk_asset_handover_document,
        DROP CONSTRAINT chk_asset_handover_closed
    `);
    await queryRunner.query(`
      ALTER TABLE asset_handover
        ADD CONSTRAINT chk_asset_handover_status
          CHECK (status IN ('AWAITING_DOCUMENT', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'CANCELLED')),
        ADD CONSTRAINT chk_asset_handover_document
          CHECK (status IN ('AWAITING_DOCUMENT', 'CANCELLED') OR document_id IS NOT NULL),
        ADD CONSTRAINT chk_asset_handover_closed
          CHECK ((status IN ('SIGNED', 'REJECTED', 'CANCELLED')) = (closed_at IS NOT NULL)),
        ADD CONSTRAINT chk_asset_handover_cancelled
          CHECK ((status = 'CANCELLED') = (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT count(*)::int AS cancelled FROM asset_handover WHERE status = 'CANCELLED'`,
    )) as Array<{ cancelled: number }>;
    if ((row?.cancelled ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row?.cancelled} entregas canceladas no tienen equivalente en el esquema anterior`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE asset_handover
        DROP CONSTRAINT chk_asset_handover_cancelled,
        DROP CONSTRAINT chk_asset_handover_status,
        DROP CONSTRAINT chk_asset_handover_document,
        DROP CONSTRAINT chk_asset_handover_closed
    `);
    await queryRunner.query(`
      ALTER TABLE asset_handover
        DROP COLUMN cancel_reason,
        DROP COLUMN cancelled_by,
        ADD CONSTRAINT chk_asset_handover_status
          CHECK (status IN ('AWAITING_DOCUMENT', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED')),
        ADD CONSTRAINT chk_asset_handover_document
          CHECK (status = 'AWAITING_DOCUMENT' OR document_id IS NOT NULL),
        ADD CONSTRAINT chk_asset_handover_closed
          CHECK ((status IN ('SIGNED', 'REJECTED')) = (closed_at IS NOT NULL))
    `);

    // received_at se reconstruye desde los movimientos RETURN (up lo rellena igual).
    await queryRunner.query('ALTER TABLE asset_loan_item DROP COLUMN received_at');

    await queryRunner.query(`UPDATE asset_loan SET status = 'ACTIVE' WHERE status = 'PENDING_SIGNATURES'`);
    await queryRunner.query(`UPDATE asset_loan SET status = 'PARTIALLY_RETURNED' WHERE status = 'CLOSED_WITH_LOSSES'`);
    await this.recreateLoanStatus(queryRunner, [
      'REQUESTED',
      'APPROVED',
      'REJECTED',
      'ACTIVE',
      'RETURNED',
      'OVERDUE',
      'CANCELLED',
      'IN_TRANSIT',
      'PENDING_RECEPTION',
      'PARTIALLY_RETURNED',
    ]);
  }

  /** Recrea loan_status con `values` (en ese orden) y sus dependientes, idénticos a como estaban. */
  private async recreateLoanStatus(queryRunner: QueryRunner, values: ReadonlyArray<string>): Promise<void> {
    await queryRunner.query('DROP VIEW v_overdue_loans');
    await queryRunner.query('DROP INDEX idx_loan_expected_return');
    await queryRunner.query('ALTER TABLE asset_loan ALTER COLUMN status DROP DEFAULT');
    await queryRunner.query('ALTER TYPE loan_status RENAME TO loan_status_previous');
    await queryRunner.query(`CREATE TYPE loan_status AS ENUM (${values.map((value) => `'${value}'`).join(', ')})`);
    await queryRunner.query(
      'ALTER TABLE asset_loan ALTER COLUMN status TYPE loan_status USING status::text::loan_status',
    );
    await queryRunner.query(`ALTER TABLE asset_loan ALTER COLUMN status SET DEFAULT 'REQUESTED'`);
    await queryRunner.query('DROP TYPE loan_status_previous');
    await queryRunner.query(
      `CREATE INDEX idx_loan_expected_return ON asset_loan(expected_return_date) WHERE status IN ('ACTIVE', 'OVERDUE')`,
    );
    await queryRunner.query(`
      CREATE VIEW v_overdue_loans AS
      SELECT
          l.id AS loan_id,
          a.internal_code,
          a.description,
          l.target_cost_center_id,
          tcc.name AS target_cost_center,
          l.expected_return_date,
          CURRENT_DATE - l.expected_return_date AS days_overdue,
          p.first_name || ' ' || p.last_name AS current_responsible
      FROM asset_loan l
      JOIN asset_loan_item i ON i.loan_id = l.id
      JOIN asset a ON a.id = i.asset_id
      JOIN cost_center tcc ON tcc.id = l.target_cost_center_id
      JOIN person p ON p.id = l.target_responsible_id
      WHERE l.status IN ('ACTIVE', 'OVERDUE')
        AND l.expected_return_date < CURRENT_DATE
    `);
  }
}
