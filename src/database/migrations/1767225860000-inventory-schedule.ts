import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Programación de tomas físicas (calendario, reprogramación, cancelación y recordatorios).
 *
 * - physical_inventory: reschedule_count / rescheduled_at ("reprogramada" es derivado: reschedule_count > 0, no un
 *   estado), reminder_offsets_days (días antes del inicio en que se recuerda; '{}' en las tomas existentes: ninguna
 *   recibe recordatorios retroactivos), cancel_reason / cancelled_at / cancelled_by.
 * - inventory_reminder: un recordatorio por (toma, días de anticipación, revisión de fechas). schedule_rev es el
 *   reschedule_count vigente al crearlo; reprogramar deja los PENDING anteriores SUPERSEDED y crea los de la nueva
 *   revisión. due_at = 07:00 America/Bogota del día (inicio - offset_days). El worker reclama PENDING vencidos con
 *   FOR UPDATE SKIP LOCKED y en la misma transacción encola correo + notificación y marca el estado final: un
 *   reinicio no reenvía.
 * - mail_outbox.recipient_person_id: los jefes de centro de costo pueden no tener usuario. recipient_user_id pasa a
 *   ser opcional y un CHECK exige exactamente uno de los dos. El correo se resuelve al enviar (person.email).
 * - Menú: "Calendario de tomas" (/inventories/calendar, physical_inventory:read, ícono existente `clipboard-check`),
 *   id fijo y ON CONFLICT (path) DO NOTHING; down() borra por ese id.
 *
 * down(): se niega si ya hay datos que se perderían (recordatorios, correos a personas sin usuario, tomas
 * reprogramadas o canceladas con motivo). No borra ni convierte datos por su cuenta.
 */

const NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000018601';

export class InventorySchedule1767225860000 implements MigrationInterface {
  name = 'InventorySchedule1767225860000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN reschedule_count      INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN rescheduled_at        TIMESTAMPTZ,
        ADD COLUMN reminder_offsets_days SMALLINT[] NOT NULL DEFAULT '{}',
        ADD COLUMN cancel_reason         TEXT,
        ADD COLUMN cancelled_at          TIMESTAMPTZ,
        ADD COLUMN cancelled_by          UUID REFERENCES app_user(id),
        ADD CONSTRAINT chk_physical_inventory_reschedule_count CHECK (reschedule_count >= 0),
        ADD CONSTRAINT chk_physical_inventory_cancel_reason CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL)
    `);

    await queryRunner.query(`
      CREATE TABLE inventory_reminder (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inventory_id  UUID NOT NULL REFERENCES physical_inventory(id) ON DELETE CASCADE,
        offset_days   SMALLINT NOT NULL,
        due_at        TIMESTAMPTZ NOT NULL,
        schedule_rev  INTEGER NOT NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        sent_at       TIMESTAMPTZ,
        processed_at  TIMESTAMPTZ,
        outbox_ids    UUID[] NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_inventory_reminder UNIQUE (inventory_id, offset_days, schedule_rev),
        CONSTRAINT chk_inventory_reminder_offset CHECK (offset_days BETWEEN 0 AND 365),
        CONSTRAINT chk_inventory_reminder_status
          CHECK (status IN ('PENDING', 'SENT', 'SKIPPED', 'CANCELLED', 'NO_RECIPIENT', 'SUPERSEDED'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_inventory_reminder_due ON inventory_reminder (due_at) WHERE status = 'PENDING'`,
    );

    await queryRunner.query(`
      ALTER TABLE mail_outbox
        ADD COLUMN recipient_person_id UUID REFERENCES person(id),
        ALTER COLUMN recipient_user_id DROP NOT NULL,
        ADD CONSTRAINT chk_mail_outbox_recipient CHECK (num_nonnulls(recipient_user_id, recipient_person_id) = 1)
    `);

    await queryRunner.query(`
      INSERT INTO navigation_item
        (id, module, module_label, resource, path, label, required_action, sort_order, icon)
      VALUES
        ('${NAV_ID}', 'INVENTORY', 'Inventarios', 'physical_inventory', '/inventories/calendar',
         'Calendario de tomas', 'read', 76, 'clipboard-check')
      ON CONFLICT (path) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM inventory_reminder)::int AS reminders,
             (SELECT count(*) FROM mail_outbox WHERE recipient_person_id IS NOT NULL)::int AS person_mails,
             (SELECT count(*) FROM physical_inventory
               WHERE reschedule_count > 0 OR cancel_reason IS NOT NULL)::int AS changed
    `)) as Array<{ reminders: number; person_mails: number; changed: number }>;
    if (row && (row.reminders > 0 || row.person_mails > 0 || row.changed > 0)) {
      throw new Error(
        `No se puede revertir la programación de tomas sin perder datos: ${row.reminders} recordatorios, ` +
          `${row.person_mails} correos del outbox dirigidos a una persona sin usuario (recipient_person_id) y ` +
          `${row.changed} tomas reprogramadas o canceladas con motivo. Revíselos y bórrelos a mano antes de revertir.`,
      );
    }

    await queryRunner.query(`DELETE FROM navigation_item WHERE id = '${NAV_ID}'`);

    await queryRunner.query(`
      ALTER TABLE mail_outbox
        DROP CONSTRAINT IF EXISTS chk_mail_outbox_recipient,
        DROP COLUMN IF EXISTS recipient_person_id,
        ALTER COLUMN recipient_user_id SET NOT NULL
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS inventory_reminder`);

    await queryRunner.query(`
      ALTER TABLE physical_inventory
        DROP CONSTRAINT IF EXISTS chk_physical_inventory_cancel_reason,
        DROP CONSTRAINT IF EXISTS chk_physical_inventory_reschedule_count,
        DROP COLUMN IF EXISTS cancelled_by,
        DROP COLUMN IF EXISTS cancelled_at,
        DROP COLUMN IF EXISTS cancel_reason,
        DROP COLUMN IF EXISTS reminder_offsets_days,
        DROP COLUMN IF EXISTS rescheduled_at,
        DROP COLUMN IF EXISTS reschedule_count
    `);
  }
}
