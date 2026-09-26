import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Importación asíncrona sobre el patrón outbox (como document_request):
 * - staging_import_job: un trabajo por importación confirmada; un worker lo toma con FOR UPDATE SKIP LOCKED y un
 *   arrendamiento (lease_id + heartbeat_at) para que dos instancias no lo procesen a la vez.
 * - mail_outbox: correos que se envían fuera de la transacción que los encola; sin SMTP quedan FAILED y visibles.
 * - notification (ya existía, sin uso): índice para listar todas las del usuario, no solo las no leídas.
 */
export class ImportJobsAndMailOutbox1767225720000 implements MigrationInterface {
  name = 'ImportJobsAndMailOutbox1767225720000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE staging_import_job (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        import_id          UUID NOT NULL REFERENCES staging_import(id) ON DELETE CASCADE,
        target             VARCHAR(20) NOT NULL,
        status             VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
        phase              VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
        attempts           INTEGER NOT NULL DEFAULT 0,
        lease_id           UUID,
        heartbeat_at       TIMESTAMPTZ,
        rows_result        JSONB,
        movements_total    INTEGER,
        movements_done     INTEGER NOT NULL DEFAULT 0,
        movements_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0,
        result             JSONB,
        last_error         TEXT,
        requested_by       UUID NOT NULL REFERENCES app_user(id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at         TIMESTAMPTZ,
        finished_at        TIMESTAMPTZ,
        CONSTRAINT uq_staging_import_job_import UNIQUE (import_id),
        CONSTRAINT chk_staging_import_job_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT chk_staging_import_job_phase CHECK (phase IN ('QUEUED', 'ROWS', 'MOVEMENTS', 'FINALIZING', 'DONE'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_staging_import_job_pending ON staging_import_job (created_at) WHERE status IN ('QUEUED', 'RUNNING')`,
    );
    await queryRunner.query(
      'CREATE INDEX idx_staging_import_job_requested ON staging_import_job (requested_by, created_at DESC)',
    );
    await queryRunner.query(`
      CREATE TABLE mail_outbox (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_type      VARCHAR(40) NOT NULL,
        recipient_user_id  UUID NOT NULL REFERENCES app_user(id),
        context            JSONB NOT NULL,
        entity_type        VARCHAR(50),
        entity_id          UUID,
        delivery_status    VARCHAR(20) NOT NULL DEFAULT 'PENDING_SEND',
        send_attempts      INTEGER NOT NULL DEFAULT 0,
        send_started_at    TIMESTAMPTZ,
        last_send_error    TEXT,
        sent_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_mail_outbox_status CHECK (delivery_status IN ('PENDING_SEND', 'SENT', 'FAILED'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_mail_outbox_pending ON mail_outbox (created_at) WHERE delivery_status <> 'SENT'`,
    );
    await queryRunner.query('CREATE INDEX idx_mail_outbox_entity ON mail_outbox (entity_type, entity_id)');
    await queryRunner.query(
      'CREATE INDEX idx_notification_recipient_all ON notification (recipient_user_id, created_at DESC)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM staging_import_job)::int AS jobs,
             (SELECT count(*) FROM mail_outbox)::int AS mails
    `)) as Array<{ jobs: number; mails: number }>;
    if (row && (row.jobs > 0 || row.mails > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.jobs} trabajos de importación, ${row.mails} correos en el outbox`,
      );
    }
    await queryRunner.query('DROP INDEX idx_notification_recipient_all');
    await queryRunner.query('DROP TABLE mail_outbox');
    await queryRunner.query('DROP TABLE staging_import_job');
  }
}
