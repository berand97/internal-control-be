import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ReassignmentReissueHashes1767225634000 implements MigrationInterface {
  name = 'ReassignmentReissueHashes1767225634000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_signature_reassignment
        ADD COLUMN previous_pdf_hash CHAR(64),
        ADD COLUMN new_pdf_hash CHAR(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT count(*)::int AS reissued FROM document_signature_reassignment
       WHERE previous_pdf_hash IS NOT NULL OR new_pdf_hash IS NOT NULL`,
    )) as Array<{ reissued: number }>;
    if ((row?.reissued ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder evidencia: ${row?.reissued} reemisiones de acta con sus hashes`);
    }
    await queryRunner.query(`
      ALTER TABLE document_signature_reassignment
        DROP COLUMN new_pdf_hash,
        DROP COLUMN previous_pdf_hash
    `);
  }
}
