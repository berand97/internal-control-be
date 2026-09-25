import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SignatureReassignment1767225632000 implements MigrationInterface {
  name = 'SignatureReassignment1767225632000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_signature_reassignment (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id      UUID NOT NULL REFERENCES document(id),
        sign_order       SMALLINT NOT NULL,
        role             VARCHAR(40) NOT NULL,
        from_person_id   UUID REFERENCES person(id),
        to_person_id     UUID NOT NULL REFERENCES person(id),
        reason           TEXT NOT NULL,
        reassigned_by    UUID NOT NULL REFERENCES app_user(id),
        session_id       UUID,
        ip_address       INET,
        user_agent       TEXT,
        reassigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_document_signature_reassignment_change
          CHECK (from_person_id IS DISTINCT FROM to_person_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_document_signature_reassignment_document ON document_signature_reassignment (document_id, reassigned_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      'SELECT count(*)::int AS reassignments FROM document_signature_reassignment',
    )) as Array<{ reassignments: number }>;
    if ((row?.reassignments ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder evidencia: ${row?.reassignments} reasignaciones de firmante`);
    }
    await queryRunner.query('DROP TABLE document_signature_reassignment');
  }
}
