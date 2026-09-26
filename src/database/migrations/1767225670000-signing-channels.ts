import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tres caminos de firma con el método como evidencia, y anulación de actas por su proceso.
 *
 * - signature_signing_link: enlace de un solo uso para firmar sin sesión (persona sin usuario activo). Solo guarda el
 *   SHA-256 del token; delivery_status es el outbox del correo (PENDING_SEND → SENT | FAILED).
 * - signature_envelope_signer.method: SESSION_MFA | SESSION | EMAIL_LINK, con la evidencia del enlace. El CHECK de
 *   evidencia pasa a depender del método (antes exigía usuario y sesión a toda firma).
 * - document.status VOIDED (anulada por su proceso) con motivo, quién y cuándo; document_request.status CANCELLED;
 *   signature_envelope.status VOIDED.
 *
 * down() se niega si hay datos que no caben en el esquema anterior (firmas por enlace, enlaces emitidos, actas
 * anuladas, solicitudes canceladas): revertir los perdería.
 */
export class SigningChannels1767225670000 implements MigrationInterface {
  name = 'SigningChannels1767225670000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE signature_signing_link (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id                 UUID NOT NULL REFERENCES document(id),
        sign_order                  SMALLINT NOT NULL,
        person_id                   UUID NOT NULL REFERENCES person(id),
        email                       VARCHAR(255) NOT NULL,
        token_hash                  CHAR(64),
        delivery_status             VARCHAR(20) NOT NULL DEFAULT 'PENDING_SEND',
        send_attempts               INTEGER NOT NULL DEFAULT 0,
        send_started_at             TIMESTAMPTZ,
        last_send_error             TEXT,
        sent_at                     TIMESTAMPTZ,
        expires_at                  TIMESTAMPTZ,
        identity_attempts           INTEGER NOT NULL DEFAULT 0,
        identity_confirmed_at       TIMESTAMPTZ,
        authorization_hash          CHAR(64),
        authorization_expires_at    TIMESTAMPTZ,
        consumed_at                 TIMESTAMPTZ,
        consumed_action             VARCHAR(20),
        invalidated_at              TIMESTAMPTZ,
        invalidated_reason          VARCHAR(30),
        created_by                  UUID REFERENCES app_user(id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_signing_link_delivery CHECK (delivery_status IN ('PENDING_SEND', 'SENT', 'FAILED')),
        CONSTRAINT chk_signing_link_consumed CHECK (
          (consumed_at IS NULL AND consumed_action IS NULL)
          OR (consumed_at IS NOT NULL AND consumed_action IN ('SIGNED', 'REJECTED') AND identity_confirmed_at IS NOT NULL)
        ),
        CONSTRAINT chk_signing_link_invalidated CHECK (
          (invalidated_at IS NULL AND invalidated_reason IS NULL)
          OR (invalidated_at IS NOT NULL AND invalidated_reason IN
              ('RESENT', 'ATTEMPTS_EXCEEDED', 'REASSIGNED', 'VOIDED', 'TURN_CHANGED'))
        ),
        CONSTRAINT chk_signing_link_sent CHECK (delivery_status <> 'SENT' OR (sent_at IS NOT NULL AND token_hash IS NOT NULL))
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_signing_link_token ON signature_signing_link (token_hash) WHERE token_hash IS NOT NULL',
    );
    // Un solo enlace abierto (sin consumir ni invalidar) por turno.
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_signing_link_open ON signature_signing_link (document_id, sign_order)
       WHERE consumed_at IS NULL AND invalidated_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_signing_link_outbox ON signature_signing_link (created_at)
       WHERE delivery_status <> 'SENT' AND consumed_at IS NULL AND invalidated_at IS NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE signature_envelope_signer
        ADD COLUMN method                 VARCHAR(20),
        ADD COLUMN signing_link_id        UUID REFERENCES signature_signing_link(id),
        ADD COLUMN link_email             VARCHAR(255),
        ADD COLUMN link_sent_at           TIMESTAMPTZ,
        ADD COLUMN identity_confirmed_at  TIMESTAMPTZ
    `);
    // Antes de esta migración toda firma y todo rechazo exigían sesión con MFA (SIGNATURE_MFA_REQUIRED).
    await queryRunner.query(`
      UPDATE signature_envelope_signer
      SET method = CASE WHEN mfa_enabled IS FALSE THEN 'SESSION' ELSE 'SESSION_MFA' END
      WHERE status <> 'PENDING'
    `);
    await queryRunner.query(
      'ALTER TABLE signature_envelope_signer DROP CONSTRAINT chk_signature_envelope_signer_evidence',
    );
    await queryRunner.query(`
      ALTER TABLE signature_envelope_signer
        ADD CONSTRAINT chk_signature_envelope_signer_method CHECK (method IS NULL OR method IN ('SESSION_MFA', 'SESSION', 'EMAIL_LINK')),
        ADD CONSTRAINT chk_signature_envelope_signer_evidence CHECK (
          status = 'PENDING'
          OR (
            signed_at IS NOT NULL AND (
              (method IN ('SESSION_MFA', 'SESSION') AND signer_user_id IS NOT NULL AND session_id IS NOT NULL)
              OR (method = 'EMAIL_LINK' AND signing_link_id IS NOT NULL AND link_email IS NOT NULL
                  AND identity_confirmed_at IS NOT NULL)
            )
          )
        )
    `);

    await queryRunner.query('ALTER TABLE signature_envelope DROP CONSTRAINT chk_signature_envelope_status');
    await queryRunner.query(`
      ALTER TABLE signature_envelope ADD CONSTRAINT chk_signature_envelope_status
        CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED', 'VOIDED'))
    `);

    await queryRunner.query(`
      ALTER TABLE document
        ADD COLUMN voided_at    TIMESTAMPTZ,
        ADD COLUMN voided_by    UUID REFERENCES app_user(id),
        ADD COLUMN void_reason  TEXT
    `);
    await queryRunner.query('ALTER TABLE document DROP CONSTRAINT chk_document_status');
    await queryRunner.query(`
      ALTER TABLE document
        ADD CONSTRAINT chk_document_status CHECK (status IN ('PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'VOIDED')),
        ADD CONSTRAINT chk_document_voided CHECK (
          (status = 'VOIDED') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)
        )
    `);

    await queryRunner.query(`
      ALTER TABLE document_request
        ADD COLUMN cancelled_at   TIMESTAMPTZ,
        ADD COLUMN cancelled_by   UUID REFERENCES app_user(id),
        ADD COLUMN cancel_reason  TEXT
    `);
    await queryRunner.query('ALTER TABLE document_request DROP CONSTRAINT chk_document_request_status');
    await queryRunner.query(`
      ALTER TABLE document_request
        ADD CONSTRAINT chk_document_request_status CHECK (status IN ('PENDING', 'GENERATED', 'FAILED', 'CANCELLED')),
        ADD CONSTRAINT chk_document_request_cancelled CHECK (
          (status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM signature_envelope_signer WHERE method = 'EMAIL_LINK')::int AS link_signatures,
        (SELECT count(*) FROM signature_signing_link)::int AS links,
        (SELECT count(*) FROM document WHERE status = 'VOIDED')::int AS voided,
        (SELECT count(*) FROM signature_envelope WHERE status = 'VOIDED')::int AS voided_envelopes,
        (SELECT count(*) FROM document_request WHERE status = 'CANCELLED')::int AS cancelled
    `)) as Array<{ link_signatures: number; links: number; voided: number; voided_envelopes: number; cancelled: number }>;
    if (row && Object.values(row).some((count) => count > 0)) {
      throw new Error(
        `No se puede revertir sin perder evidencia: ${row.link_signatures} firmas por enlace, ${row.links} enlaces de firma, ` +
          `${row.voided} actas anuladas, ${row.voided_envelopes} sobres anulados, ${row.cancelled} solicitudes canceladas`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE document_request
        DROP CONSTRAINT chk_document_request_cancelled,
        DROP CONSTRAINT chk_document_request_status
    `);
    await queryRunner.query(`
      ALTER TABLE document_request
        ADD CONSTRAINT chk_document_request_status CHECK (status IN ('PENDING', 'GENERATED', 'FAILED')),
        DROP COLUMN cancel_reason,
        DROP COLUMN cancelled_by,
        DROP COLUMN cancelled_at
    `);
    await queryRunner.query(`
      ALTER TABLE document
        DROP CONSTRAINT chk_document_voided,
        DROP CONSTRAINT chk_document_status
    `);
    await queryRunner.query(`
      ALTER TABLE document
        ADD CONSTRAINT chk_document_status CHECK (status IN ('PENDING_SIGNATURE', 'SIGNED', 'REJECTED')),
        DROP COLUMN void_reason,
        DROP COLUMN voided_by,
        DROP COLUMN voided_at
    `);
    await queryRunner.query('ALTER TABLE signature_envelope DROP CONSTRAINT chk_signature_envelope_status');
    await queryRunner.query(`
      ALTER TABLE signature_envelope ADD CONSTRAINT chk_signature_envelope_status
        CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED'))
    `);
    await queryRunner.query(`
      ALTER TABLE signature_envelope_signer
        DROP CONSTRAINT chk_signature_envelope_signer_evidence,
        DROP CONSTRAINT chk_signature_envelope_signer_method
    `);
    await queryRunner.query(`
      ALTER TABLE signature_envelope_signer ADD CONSTRAINT chk_signature_envelope_signer_evidence CHECK (
        status = 'PENDING'
        OR (signed_at IS NOT NULL AND signer_user_id IS NOT NULL AND session_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE signature_envelope_signer
        DROP COLUMN identity_confirmed_at,
        DROP COLUMN link_sent_at,
        DROP COLUMN link_email,
        DROP COLUMN signing_link_id,
        DROP COLUMN method
    `);
    await queryRunner.query('DROP TABLE signature_signing_link');
  }
}
