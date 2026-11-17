import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InventoryCompanionAgreement1767226170000 implements MigrationInterface {
  name = 'InventoryCompanionAgreement1767226170000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_location_companion (
        inventory_id  UUID NOT NULL REFERENCES physical_inventory(id) ON DELETE CASCADE,
        location_id   UUID NOT NULL REFERENCES location(id),
        person_id     UUID REFERENCES person(id),
        name          VARCHAR(200),
        recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        recorded_by   UUID NOT NULL REFERENCES app_user(id),
        PRIMARY KEY (inventory_id, location_id),
        CONSTRAINT inventory_location_companion_who CHECK (
          (person_id IS NOT NULL AND name IS NULL) OR (person_id IS NULL AND name IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        ADD COLUMN IF NOT EXISTS companion_person_id UUID REFERENCES person(id),
        ADD COLUMN IF NOT EXISTS companion_name VARCHAR(200)
    `);
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN IF NOT EXISTS accounting_signer_person_id UUID REFERENCES person(id)
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS physical_inventory_act_agreement (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        act_id                UUID NOT NULL UNIQUE REFERENCES physical_inventory_act(id) ON DELETE CASCADE,
        status                VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        head_person_id        UUID NOT NULL REFERENCES person(id),
        comment               TEXT,
        responded_at          TIMESTAMPTZ,
        summary_snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,
        issued_with_objection BOOLEAN NOT NULL DEFAULT FALSE,
        issue_objection_reason TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT physical_inventory_act_agreement_status CHECK (status IN ('PENDING', 'AGREED', 'OBJECTED')),
        CONSTRAINT physical_inventory_act_agreement_comment CHECK (
          status <> 'OBJECTED' OR (comment IS NOT NULL AND length(trim(comment)) > 0)
        )
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS physical_inventory_act_agreement_history (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agreement_id     UUID NOT NULL REFERENCES physical_inventory_act_agreement(id) ON DELETE CASCADE,
        status           VARCHAR(20) NOT NULL,
        comment          TEXT,
        responded_at     TIMESTAMPTZ,
        summary_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        archived_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_by      UUID REFERENCES app_user(id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_act_agreement_link (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agreement_id     UUID NOT NULL REFERENCES physical_inventory_act_agreement(id) ON DELETE CASCADE,
        token_hash       TEXT,
        expires_at       TIMESTAMPTZ,
        consumed_at      TIMESTAMPTZ,
        delivery_status  VARCHAR(20) NOT NULL DEFAULT 'PENDING_SEND',
        send_attempts    INTEGER NOT NULL DEFAULT 0,
        sent_at          TIMESTAMPTZ,
        last_send_error  TEXT,
        reminder_day3_at TIMESTAMPTZ,
        reminder_day6_at TIMESTAMPTZ,
        invalidated_at   TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_inventory_act_agreement_link_hash ON inventory_act_agreement_link (token_hash) WHERE token_hash IS NOT NULL',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_inventory_act_agreement_link_pending ON inventory_act_agreement_link (delivery_status, expires_at) WHERE consumed_at IS NULL AND invalidated_at IS NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS inventory_act_agreement_link');
    await queryRunner.query('DROP TABLE IF EXISTS physical_inventory_act_agreement_history');
    await queryRunner.query('DROP TABLE IF EXISTS physical_inventory_act_agreement');
    await queryRunner.query(
      'ALTER TABLE physical_inventory_item DROP COLUMN IF EXISTS companion_person_id, DROP COLUMN IF EXISTS companion_name',
    );
    await queryRunner.query('ALTER TABLE physical_inventory DROP COLUMN IF EXISTS accounting_signer_person_id');
    await queryRunner.query('DROP TABLE IF EXISTS inventory_location_companion');
  }
}
