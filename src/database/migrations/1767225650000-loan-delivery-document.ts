import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enlace préstamo ↔ acta de entrega (OCI-01-65):
 * - asset_loan.delivery_document_id: el acta que generó el outbox para la entrega. Lo escribe el manejador
 *   onGenerated del préstamo (DocumentLifecycleRegistry), dentro de la transacción que inserta el documento.
 * - Un acta pertenece a lo sumo a un préstamo.
 */
export class LoanDeliveryDocument1767225650000 implements MigrationInterface {
  name = 'LoanDeliveryDocument1767225650000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE asset_loan ADD COLUMN delivery_document_id UUID REFERENCES document(id)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_asset_loan_delivery_document ON asset_loan (delivery_document_id)
       WHERE delivery_document_id IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El enlace se puede reconstruir desde document.entity_type = 'LOAN' / entity_id: bajarlo no pierde evidencia.
    await queryRunner.query('DROP INDEX uq_asset_loan_delivery_document');
    await queryRunner.query('ALTER TABLE asset_loan DROP COLUMN delivery_document_id');
  }
}
