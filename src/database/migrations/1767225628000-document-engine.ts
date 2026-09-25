import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentEngine1767225628000 implements MigrationInterface {
  name = 'DocumentEngine1767225628000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_template_version (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        format_key         VARCHAR(40) NOT NULL,
        sgc_code           VARCHAR(20) NOT NULL,
        sgc_version        VARCHAR(10) NOT NULL,
        effective_date     DATE NOT NULL,
        storage_driver     VARCHAR(20) NOT NULL,
        storage_key        TEXT NOT NULL,
        file_hash          CHAR(64) NOT NULL,
        original_filename  VARCHAR(255) NOT NULL,
        placeholders       JSONB NOT NULL,
        uploaded_by        UUID REFERENCES app_user(id),
        uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_document_template_version UNIQUE (format_key, effective_date)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE document_sequence (
        format_key     VARCHAR(40) NOT NULL,
        period         VARCHAR(10) NOT NULL,
        current_value  BIGINT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (format_key, period),
        CONSTRAINT chk_document_sequence_positive CHECK (current_value >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE document (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        format_key           VARCHAR(40) NOT NULL,
        number               VARCHAR(40) NOT NULL,
        period               VARCHAR(10) NOT NULL,
        sequence_value       BIGINT NOT NULL,
        template_version_id  UUID NOT NULL REFERENCES document_template_version(id),
        status               VARCHAR(20) NOT NULL,
        entity_type          VARCHAR(40),
        entity_id            UUID,
        data                 JSONB NOT NULL,
        docx_driver          VARCHAR(20) NOT NULL,
        docx_key             TEXT NOT NULL,
        docx_hash            CHAR(64) NOT NULL,
        pdf_driver           VARCHAR(20) NOT NULL,
        pdf_key              TEXT NOT NULL,
        pdf_hash             CHAR(64) NOT NULL,
        signature_provider   VARCHAR(40),
        signature_reference  VARCHAR(200),
        created_by           UUID REFERENCES app_user(id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        signed_at            TIMESTAMPTZ,
        CONSTRAINT uq_document_number UNIQUE (format_key, number),
        CONSTRAINT chk_document_status CHECK (status IN ('PENDING_SIGNATURE', 'SIGNED', 'REJECTED'))
      )
    `);
    await queryRunner.query('CREATE INDEX idx_document_entity ON document (entity_type, entity_id)');
    await queryRunner.query(`
      CREATE TABLE document_signature (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id       UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
        sign_order        SMALLINT NOT NULL,
        role              VARCHAR(40) NOT NULL,
        signer_person_id  UUID REFERENCES person(id),
        signer_name       VARCHAR(200),
        signer_document   VARCHAR(40),
        status            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        signed_at         TIMESTAMPTZ,
        evidence          JSONB,
        CONSTRAINT uq_document_signature_order UNIQUE (document_id, sign_order),
        CONSTRAINT chk_document_signature_status CHECK (status IN ('PENDING', 'SIGNED', 'REJECTED'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE document_request (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        format_key    VARCHAR(40) NOT NULL,
        payload       JSONB NOT NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        document_id   UUID REFERENCES document(id),
        requested_by  UUID REFERENCES app_user(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at  TIMESTAMPTZ,
        CONSTRAINT chk_document_request_status CHECK (status IN ('PENDING', 'GENERATED', 'FAILED'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_document_request_pending ON document_request (created_at) WHERE status <> 'GENERATED'`,
    );
    await queryRunner.query('ALTER TABLE generated_document ADD COLUMN storage_driver VARCHAR(20)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM document)::int AS documents,
        (SELECT count(*) FROM document_template_version)::int AS templates,
        (SELECT count(*) FROM document_request)::int AS requests,
        (SELECT count(*) FROM document_sequence)::int AS sequences,
        (SELECT count(*) FROM generated_document WHERE storage_driver IS NOT NULL)::int AS legacy
    `)) as Array<{ documents: number; templates: number; requests: number; sequences: number; legacy: number }>;
    if (row && Object.values(row).some((count) => count > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.documents} documentos, ${row.templates} plantillas, ` +
          `${row.requests} solicitudes, ${row.sequences} consecutivos, ${row.legacy} documentos con driver registrado`,
      );
    }
    await queryRunner.query('ALTER TABLE generated_document DROP COLUMN storage_driver');
    await queryRunner.query('DROP TABLE document_request');
    await queryRunner.query('DROP TABLE document_signature');
    await queryRunner.query('DROP TABLE document');
    await queryRunner.query('DROP TABLE document_sequence');
    await queryRunner.query('DROP TABLE document_template_version');
  }
}
