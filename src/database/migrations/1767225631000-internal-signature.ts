import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InternalSignature1767225631000 implements MigrationInterface {
  name = 'InternalSignature1767225631000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE signature_envelope (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id           UUID NOT NULL REFERENCES document(id),
        verification_code     VARCHAR(64) NOT NULL,
        original_pdf_sha256   CHAR(64) NOT NULL,
        prepared_pdf_sha256   CHAR(64) NOT NULL,
        current_pdf_driver    VARCHAR(20) NOT NULL,
        current_pdf_key       TEXT NOT NULL,
        current_pdf_sha256    CHAR(64) NOT NULL,
        status                VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at          TIMESTAMPTZ,
        CONSTRAINT uq_signature_envelope_code UNIQUE (verification_code),
        CONSTRAINT chk_signature_envelope_status CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED'))
      )
    `);
    await queryRunner.query('CREATE INDEX idx_signature_envelope_document ON signature_envelope (document_id)');
    await queryRunner.query(`
      CREATE TABLE signature_envelope_signer (
        envelope_id        UUID NOT NULL REFERENCES signature_envelope(id) ON DELETE CASCADE,
        sign_order         SMALLINT NOT NULL,
        role               VARCHAR(40) NOT NULL,
        role_label         VARCHAR(80),
        person_id          UUID REFERENCES person(id),
        name               VARCHAR(200),
        document_number    VARCHAR(40),
        status             VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        signed_at          TIMESTAMPTZ,
        signer_user_id     UUID REFERENCES app_user(id),
        session_id         UUID,
        ip_address         INET,
        user_agent         TEXT,
        mfa_enabled        BOOLEAN,
        rubric_driver      VARCHAR(20),
        rubric_key         TEXT,
        rubric_sha256      CHAR(64),
        pdf_sha256_before  CHAR(64),
        pdf_sha256_after   CHAR(64),
        reject_reason      TEXT,
        PRIMARY KEY (envelope_id, sign_order),
        CONSTRAINT chk_signature_envelope_signer_status CHECK (status IN ('PENDING', 'SIGNED', 'REJECTED')),
        CONSTRAINT chk_signature_envelope_signer_evidence CHECK (
          status = 'PENDING'
          OR (signed_at IS NOT NULL AND signer_user_id IS NOT NULL AND session_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      ALTER TABLE document
        ADD COLUMN signed_pdf_driver VARCHAR(20),
        ADD COLUMN signed_pdf_key TEXT,
        ADD COLUMN signed_pdf_hash CHAR(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM signature_envelope)::int AS envelopes,
        (SELECT count(*) FROM document WHERE signed_pdf_key IS NOT NULL)::int AS signed
    `)) as Array<{ envelopes: number; signed: number }>;
    if (row && (row.envelopes > 0 || row.signed > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.envelopes} solicitudes de firma, ${row.signed} documentos firmados`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE document
        DROP COLUMN signed_pdf_hash,
        DROP COLUMN signed_pdf_key,
        DROP COLUMN signed_pdf_driver
    `);
    await queryRunner.query('DROP TABLE signature_envelope_signer');
    await queryRunner.query('DROP TABLE signature_envelope');
  }
}
