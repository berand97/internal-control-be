import type { MigrationInterface, QueryRunner } from 'typeorm';

const FORMAT_KEY = 'OCI-17-90-BAJA';
const PROPOSED_TEMPLATE = 'Plantilla propuesta por desarrollo, validar con Control Interno';
const CHANGE_REASON = 'Baja de activos con acta firmada: plantilla provisional';

export class AssetWriteOffs1767226100000 implements MigrationInterface {
  name = 'AssetWriteOffs1767226100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE asset_write_off (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status                 VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        cost_center_id         UUID NOT NULL REFERENCES cost_center(id),
        responsible_person_id  UUID NOT NULL REFERENCES person(id),
        control_person_id      UUID REFERENCES person(id),
        reason                 VARCHAR(30) NOT NULL,
        reason_detail          TEXT,
        technical_concept      TEXT NOT NULL,
        final_disposition      TEXT NOT NULL,
        observations           TEXT,
        document_request_id    UUID REFERENCES document_request(id),
        document_id            UUID REFERENCES document(id),
        created_by             UUID NOT NULL REFERENCES app_user(id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        generated_by           UUID REFERENCES app_user(id),
        generated_at           TIMESTAMPTZ,
        completed_at           TIMESTAMPTZ,
        rejected_at            TIMESTAMPTZ,
        cancelled_at           TIMESTAMPTZ,
        cancelled_by           UUID REFERENCES app_user(id),
        cancel_reason          TEXT,
        CONSTRAINT chk_asset_write_off_status
          CHECK (status IN ('DRAFT', 'PENDING_SIGNATURES', 'COMPLETED', 'REJECTED', 'CANCELLED')),
        CONSTRAINT chk_asset_write_off_reason
          CHECK (reason IN ('OBSOLESCENCE', 'IRREPARABLE_DAMAGE', 'LOSS', 'THEFT', 'DONATION', 'PERMANENT_TRANSFER', 'OTHER')),
        CONSTRAINT chk_asset_write_off_other_detail
          CHECK (reason <> 'OTHER' OR length(btrim(coalesce(reason_detail, ''))) >= 3),
        CONSTRAINT chk_asset_write_off_concept CHECK (length(btrim(technical_concept)) >= 3),
        CONSTRAINT chk_asset_write_off_disposition CHECK (length(btrim(final_disposition)) >= 3),
        CONSTRAINT chk_asset_write_off_generated
          CHECK (status IN ('DRAFT', 'CANCELLED') OR document_request_id IS NOT NULL),
        CONSTRAINT chk_asset_write_off_completed CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
        CONSTRAINT chk_asset_write_off_rejected CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL)),
        CONSTRAINT chk_asset_write_off_cancelled
          CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)),
        CONSTRAINT uq_asset_write_off_document UNIQUE (document_id),
        CONSTRAINT uq_asset_write_off_request UNIQUE (document_request_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_asset_write_off_status ON asset_write_off (status, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_asset_write_off_center ON asset_write_off (cost_center_id)');
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_write_off_touch BEFORE UPDATE ON asset_write_off
        FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()
    `);
    await queryRunner.query(`
      CREATE TABLE asset_write_off_item (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        write_off_id  UUID NOT NULL REFERENCES asset_write_off(id),
        asset_id      UUID NOT NULL REFERENCES asset(id),
        line_number   SMALLINT NOT NULL,
        open          BOOLEAN NOT NULL DEFAULT TRUE,
        movement_id   UUID REFERENCES asset_movement(id),
        CONSTRAINT uq_asset_write_off_item_asset UNIQUE (write_off_id, asset_id),
        CONSTRAINT uq_asset_write_off_item_line UNIQUE (write_off_id, line_number),
        CONSTRAINT uq_asset_write_off_item_movement UNIQUE (movement_id)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_asset_write_off_item_open ON asset_write_off_item (asset_id) WHERE open');
    await queryRunner.query('CREATE INDEX idx_asset_write_off_item_asset ON asset_write_off_item (asset_id)');

    const [latest] = (await queryRunner.query(
      `SELECT id, version_number, pending_decisions FROM document_format_version
       WHERE format_key = $1 ORDER BY version_number DESC LIMIT 1`,
      [FORMAT_KEY],
    )) as Array<{ id: string; version_number: number; pending_decisions: string[] }>;
    if (!latest || latest.pending_decisions.includes(PROPOSED_TEMPLATE)) {
      return;
    }
    const [created] = (await queryRunner.query(
      `INSERT INTO document_format_version (format_key, version_number, sgc_code, sgc_version, name, effective_from,
         numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period, pending_decisions, change_reason)
       SELECT format_key, version_number + 1, sgc_code, sgc_version, name,
              GREATEST(coalesce(effective_from, '-infinity'::date), (NOW() AT TIME ZONE 'America/Bogota')::date),
              numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period,
              pending_decisions || $2::jsonb, $3
       FROM document_format_version WHERE id = $1
       RETURNING id`,
      [latest.id, JSON.stringify([PROPOSED_TEMPLATE]), CHANGE_REASON],
    )) as Array<{ id: string }>;
    await queryRunner.query(
      `INSERT INTO document_format_signer (version_id, sign_order, role, label, source)
       SELECT $2, sign_order, role, label, source FROM document_format_signer WHERE version_id = $1`,
      [latest.id, created?.id],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT (SELECT count(*)::int FROM asset_write_off) AS write_offs,
              (SELECT count(*)::int FROM document d JOIN document_format_version v ON v.id = d.format_version_id
                 WHERE v.format_key = $1 AND v.change_reason = $2) AS documents`,
      [FORMAT_KEY, CHANGE_REASON],
    )) as Array<{ write_offs: number; documents: number }>;
    if ((row?.write_offs ?? 0) > 0 || (row?.documents ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder datos: ${row?.write_offs} bajas y ${row?.documents} actas de la versión nueva`);
    }
    await queryRunner.query(
      `DELETE FROM document_format_signer WHERE version_id IN
         (SELECT id FROM document_format_version WHERE format_key = $1 AND change_reason = $2)`,
      [FORMAT_KEY, CHANGE_REASON],
    );
    await queryRunner.query('DELETE FROM document_format_version WHERE format_key = $1 AND change_reason = $2', [
      FORMAT_KEY,
      CHANGE_REASON,
    ]);
    await queryRunner.query('DROP TABLE asset_write_off_item');
    await queryRunner.query('DROP TABLE asset_write_off');
  }
}
