import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Canal de eventos en tiempo real (SSE, src/modules/events).
 *
 * 1. notification.event_seq: número creciente asignado al insertar (identidad). Es el id de evento SSE de cada
 *    notificación: monótono y reproducible, así GET /events repone con Last-Event-ID las posteriores al último que
 *    vio el navegador. Las filas existentes reciben su número al agregar la columna. Índice (recipient_user_id,
 *    event_seq) para la reposición por usuario.
 * 2. event_stream_ticket: tickets de un solo uso de POST /events/ticket (vida <= 30 s). Solo se guarda el SHA-256 del
 *    ticket (nunca el valor), ligado al usuario y a su sesión (refresh_token_family); se borra al consumirlo y los
 *    vencidos se purgan al emitir otros. En tabla y no en memoria: con más de una instancia el ticket emitido en una
 *    sirve en la otra.
 *
 * down(): quita la tabla (los tickets son efímeros) y la columna con su índice.
 */
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
