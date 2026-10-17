import type { MigrationInterface, QueryRunner } from 'typeorm';

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
    await queryRunner.query('DROP INDEX uq_asset_loan_delivery_document');
    await queryRunner.query('ALTER TABLE asset_loan DROP COLUMN delivery_document_id');
  }
}
