import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Solicitudes cuyo préstamo programado se rechaza.
 *
 * 1. asset_request.status CLOSED_LOAN_REJECTED: la solicitud TEMPORARY generó su préstamo (LOAN_SCHEDULED, préstamo
 *    APPROVED) y ese préstamo se rechazó antes de entregarse (POST /loans/:id/reject). La solicitud se cierra con el
 *    motivo del rechazo (evento LOAN_REJECTED); los activos quedan libres porque el préstamo rechazado ya no es un
 *    préstamo abierto. Conserva loan_id (el préstamo rechazado) y la aceptación, como DOCUMENT_GENERATED.
 *
 * down(): se niega si hay solicitudes CLOSED_LOAN_REJECTED (no existe un estado anterior que diga lo mismo).
 */
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
