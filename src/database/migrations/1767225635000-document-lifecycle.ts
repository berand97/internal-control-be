import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Soporte del gancho de completitud (DocumentLifecycleRegistry):
 * - document.lifecycle_*: el último fallo del manejador del proceso al pasar el acta a SIGNED o REJECTED.
 *   Mientras lifecycle_error no sea NULL el acta sigue en PENDING_SIGNATURE y el job la reintenta.
 * - idx_document_request_entity: consultar las solicitudes del outbox de una entidad (payload.entityType/entityId).
 */
export class DocumentLifecycle1767225635000 implements MigrationInterface {
  name = 'DocumentLifecycle1767225635000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document
        ADD COLUMN lifecycle_error TEXT,
        ADD COLUMN lifecycle_failed_at TIMESTAMPTZ,
        ADD COLUMN lifecycle_attempts INTEGER NOT NULL DEFAULT 0
    `);
    await queryRunner.query(
      `CREATE INDEX idx_document_lifecycle_failed ON document (lifecycle_failed_at) WHERE lifecycle_error IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_document_request_entity ON document_request ((payload->>'entityType'), (payload->>'entityId'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      'SELECT count(*)::int AS failed FROM document WHERE lifecycle_error IS NOT NULL',
    )) as Array<{ failed: number }>;
    if ((row?.failed ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin perder evidencia: ${row?.failed} actas con un fallo pendiente del proceso que las originó`,
      );
    }
    await queryRunner.query('DROP INDEX idx_document_request_entity');
    await queryRunner.query('DROP INDEX idx_document_lifecycle_failed');
    await queryRunner.query(`
      ALTER TABLE document
        DROP COLUMN lifecycle_attempts,
        DROP COLUMN lifecycle_failed_at,
        DROP COLUMN lifecycle_error
    `);
  }
}
