import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase5MovementsLoans1767225608000 implements MigrationInterface {
  name = 'Phase5MovementsLoans1767225608000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'QR_ROTATION'
    `);
    await queryRunner.query(`
      ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'CORRECTION'
    `);

    await queryRunner.query(`
      ALTER TABLE asset_movement
        ADD COLUMN IF NOT EXISTS previous_movement_id UUID REFERENCES asset_movement(id),
        ADD COLUMN IF NOT EXISTS metadata JSONB
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS movement_verification_log (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        assets_checked  INT NOT NULL,
        failures        INT NOT NULL,
        details         JSONB
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_prevent_movement_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'asset_movement is append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_asset_movement_no_update ON asset_movement
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_movement_no_update
        BEFORE UPDATE OR DELETE ON asset_movement
        FOR EACH ROW EXECUTE FUNCTION fn_prevent_movement_mutation()
    `);

    await queryRunner.query(`
      ALTER TYPE loan_status ADD VALUE IF NOT EXISTS 'IN_TRANSIT'
    `);
    await queryRunner.query(`
      ALTER TYPE loan_status ADD VALUE IF NOT EXISTS 'PENDING_RECEPTION'
    `);
    await queryRunner.query(`
      ALTER TYPE loan_status ADD VALUE IF NOT EXISTS 'PARTIALLY_RETURNED'
    `);

    await queryRunner.query(`
      ALTER TABLE asset_loan
        ADD COLUMN IF NOT EXISTS rejected_reason TEXT,
        ADD COLUMN IF NOT EXISTS extension_requested_date DATE
    `);
    await queryRunner.query(`
      ALTER TABLE asset_loan
        ALTER COLUMN target_responsible_id DROP NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS asset_loan_item (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        loan_id                 UUID NOT NULL REFERENCES asset_loan(id) ON DELETE CASCADE,
        asset_id                UUID NOT NULL REFERENCES asset(id),
        source_cost_center_id   UUID NOT NULL REFERENCES cost_center(id),
        status_on_loan          VARCHAR(30),
        condition_on_delivery   VARCHAR(20),
        return_condition        VARCHAR(20),
        returned_at             TIMESTAMPTZ,
        UNIQUE (loan_id, asset_id)
      )
    `);
    await queryRunner.query(`
      INSERT INTO asset_loan_item (loan_id, asset_id, source_cost_center_id)
      SELECT id, asset_id, source_cost_center_id
      FROM asset_loan
      WHERE asset_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM asset_loan_item i WHERE i.loan_id = asset_loan.id
        )
    `);
    await queryRunner.query(`
      ALTER TABLE asset_loan ALTER COLUMN asset_id DROP NOT NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE VIEW v_overdue_loans AS
      SELECT
          l.id AS loan_id,
          a.internal_code,
          a.description,
          l.target_cost_center_id,
          tcc.name AS target_cost_center,
          l.expected_return_date,
          CURRENT_DATE - l.expected_return_date AS days_overdue,
          p.first_name || ' ' || p.last_name AS current_responsible
      FROM asset_loan l
      JOIN asset_loan_item i ON i.loan_id = l.id
      JOIN asset a ON a.id = i.asset_id
      JOIN cost_center tcc ON tcc.id = l.target_cost_center_id
      JOIN person p ON p.id = l.target_responsible_id
      WHERE l.status IN ('ACTIVE', 'OVERDUE')
        AND l.expected_return_date < CURRENT_DATE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS asset_loan_event (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        loan_id       UUID NOT NULL REFERENCES asset_loan(id) ON DELETE CASCADE,
        event_type    VARCHAR(40) NOT NULL,
        payload       JSONB,
        performed_by  UUID NOT NULL REFERENCES app_user(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS loan_attachment (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        loan_id       UUID NOT NULL REFERENCES asset_loan(id) ON DELETE CASCADE,
        kind          VARCHAR(40) NOT NULL,
        storage_key   TEXT NOT NULL,
        file_hash     VARCHAR(64) NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by    UUID NOT NULL REFERENCES app_user(id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_template (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_type       VARCHAR(40) NOT NULL,
        version             INT NOT NULL,
        storage_key         TEXT NOT NULL,
        file_hash           VARCHAR(64) NOT NULL,
        original_filename   VARCHAR(255) NOT NULL,
        placeholders        JSONB NOT NULL,
        is_active           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by          UUID NOT NULL REFERENCES app_user(id),
        UNIQUE (document_type, version)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS generated_document (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_type   VARCHAR(40) NOT NULL,
        template_id     UUID NOT NULL REFERENCES document_template(id),
        storage_key     TEXT NOT NULL,
        file_hash       VARCHAR(64) NOT NULL,
        act_number      VARCHAR(40) NOT NULL,
        entity_type     VARCHAR(40) NOT NULL,
        entity_id       UUID NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by      UUID NOT NULL REFERENCES app_user(id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS storage_settings (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver                    VARCHAR(20) NOT NULL DEFAULT 'project',
        project_path              TEXT,
        s3_provider               VARCHAR(30),
        s3_endpoint               TEXT,
        s3_region                 VARCHAR(50),
        s3_bucket                 VARCHAR(200),
        s3_access_key             TEXT,
        s3_secret_key             TEXT,
        s3_force_path_style       BOOLEAN,
        google_client_id          TEXT,
        google_client_secret      TEXT,
        google_refresh_token      TEXT,
        google_folder_id          TEXT,
        onedrive_tenant_id        TEXT,
        onedrive_client_id        TEXT,
        onedrive_client_secret    TEXT,
        onedrive_refresh_token    TEXT,
        onedrive_folder_id        TEXT,
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by                UUID REFERENCES app_user(id)
      )
    `);
    await queryRunner.query(`
      INSERT INTO storage_settings (driver, project_path, s3_provider)
      SELECT 'project', 'storage', 'minio'
      WHERE NOT EXISTS (SELECT 1 FROM storage_settings)
    `);

    await queryRunner.query(`
      INSERT INTO code_sequence (sequence_name, prefix, current_value, padding_length)
      VALUES ('document_act', 'ACT-', 0, 4)
      ON CONFLICT (sequence_name) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description) VALUES
        ('loan:update:global', 'LOAN', 'loan', 'update', 'GLOBAL', 'Entregar y recibir préstamos'),
        ('loan:approve:global', 'LOAN', 'loan', 'approve', 'GLOBAL', 'Aprobar cualquier préstamo'),
        ('storage:manage:global', 'SYSTEM', 'storage', 'update', 'GLOBAL', 'Administrar almacenamiento'),
        ('document_template:read:global', 'SYSTEM', 'document_template', 'read', 'GLOBAL', 'Ver plantillas Word'),
        ('document_template:update:global', 'SYSTEM', 'document_template', 'update', 'GLOBAL', 'Subir y activar plantillas Word')
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'loan:read:global',
        'loan:request:own',
        'loan:approve:global',
        'loan:update:global',
        'storage:manage:global',
        'document_template:read:global',
        'document_template:update:global'
      )
      WHERE r.code IN ('SUPER_ADMIN', 'INTERNAL_CONTROL_DIRECTOR')
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r, permission p
      WHERE r.code = 'AUDITOR' AND p.code IN (
        'loan:read:global',
        'document_template:read:global'
      )
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_asset_movement_no_update ON asset_movement`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_prevent_movement_mutation()`);
    await queryRunner.query(`DROP TABLE IF EXISTS generated_document`);
    await queryRunner.query(`DROP TABLE IF EXISTS document_template`);
    await queryRunner.query(`DROP TABLE IF EXISTS loan_attachment`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_loan_event`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_loan_item`);
    await queryRunner.query(`DROP TABLE IF EXISTS movement_verification_log`);
    await queryRunner.query(`DROP TABLE IF EXISTS storage_settings`);
  }
}
