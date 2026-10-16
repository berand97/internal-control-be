import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EventStream1767225950000 implements MigrationInterface {
  name = 'EventStream1767225950000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE notification ADD COLUMN event_seq BIGINT GENERATED ALWAYS AS IDENTITY');
    await queryRunner.query(
      'CREATE INDEX idx_notification_recipient_event_seq ON notification (recipient_user_id, event_seq)',
    );
    await queryRunner.query(`
      CREATE TABLE event_stream_ticket (
        token_hash  BYTEA PRIMARY KEY,
        user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        session_id  UUID NOT NULL REFERENCES refresh_token_family(id) ON DELETE CASCADE,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_event_stream_ticket_expires ON event_stream_ticket (expires_at)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE event_stream_ticket');
    await queryRunner.query('DROP INDEX idx_notification_recipient_event_seq');
    await queryRunner.query('ALTER TABLE notification DROP COLUMN event_seq');
  }
}
