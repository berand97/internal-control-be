import type { MigrationInterface, QueryRunner } from 'typeorm';

const REPORT_VIEW_HEAD = `
CREATE OR REPLACE VIEW v_asset_report AS
SELECT
    a.id                                            AS mov_id_activo,
    a.barcode                                       AS mov_cod_barras,
    a.description                                   AS mov_descripcion,
    a.model                                         AS mov_modelo,
    a.acquisition_document                          AS mov_num_documento,
    a.serial_number                                 AS mov_num_serie,`;

const REPORT_VIEW_TAIL = `
    cc.external_code                                AS mov_id_centro,
    cc.name                                         AS nombre_centro,
    cc.external_code || ' ' || cc.name              AS completo,
    a.acquisition_date                              AS mov_fecha_compra,
    CASE WHEN a.operational_status = 'WRITTEN_OFF' THEN 'SI' ELSE 'NO' END AS mov_debaja,
    a.physical_condition                            AS estado,
    CASE WHEN a.last_verified_at IS NOT NULL THEN 'Si' ELSE 'No' END AS validado_toma_fisica,
    p.first_name || ' ' || p.last_name              AS responsable,
    p.position_title                                AS cargo,
    a.written_off_at                                AS mov_fecha_debaja,
    a.useful_life_years                             AS mov_ano_depre,
    a.notes                                         AS mov_observaciones,
    a.acquisition_price                             AS mov_precio_compra`;

const REPORT_VIEW_FROM = `
FROM asset a
LEFT JOIN cost_center cc ON cc.id = a.current_cost_center_id
LEFT JOIN person p       ON p.id = a.current_responsible_id`;

const ORIGINAL_REPORT_VIEW = `${REPORT_VIEW_HEAD}
    (SELECT file_url FROM asset_photo p
        WHERE p.asset_id = a.id AND p.is_primary LIMIT 1) AS fotografia_activo,${REPORT_VIEW_TAIL}${REPORT_VIEW_FROM}`;

const PHOTO_REPORT_VIEW = `${REPORT_VIEW_HEAD}
    (SELECT CASE WHEN ph.file_id IS NOT NULL
                 THEN '/assets/' || a.id || '/photos/' || ph.id || '/content'
                 ELSE ph.file_url END
       FROM asset_photo ph
      WHERE ph.asset_id = a.id AND ph.is_primary AND ph.unlinked_at IS NULL LIMIT 1) AS fotografia_activo,${REPORT_VIEW_TAIL},
    (SELECT ph.id FROM asset_photo ph
      WHERE ph.asset_id = a.id AND ph.is_primary AND ph.unlinked_at IS NULL AND ph.file_id IS NOT NULL
      LIMIT 1)                                      AS fotografia_id${REPORT_VIEW_FROM}`;

const DRIVERS = `('project', 's3', 'google_drive', 'onedrive')`;
const PHOTO_TYPES = `('image/jpeg', 'image/png', 'image/webp')`;

export class AssetPhotoFiles1767226120000 implements MigrationInterface {
  name = 'AssetPhotoFiles1767226120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE photo_file (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        storage_driver  VARCHAR(20) NOT NULL,
        storage_key     VARCHAR(1024) NOT NULL,
        thumb_key       VARCHAR(1024) NOT NULL,
        sha256          VARCHAR(64) NOT NULL,
        content_type    VARCHAR(40) NOT NULL,
        byte_size       INTEGER NOT NULL,
        width           INTEGER NOT NULL,
        height          INTEGER NOT NULL,
        cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
        upload_year     SMALLINT NOT NULL,
        origin_asset_id UUID REFERENCES asset(id) ON DELETE SET NULL,
        uploaded_by     UUID NOT NULL REFERENCES app_user(id),
        uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_photo_file_storage_key UNIQUE (storage_key),
        CONSTRAINT uq_photo_file_thumb_key UNIQUE (thumb_key),
        CONSTRAINT chk_photo_file_driver CHECK (storage_driver IN ${DRIVERS}),
        CONSTRAINT chk_photo_file_content_type CHECK (content_type IN ${PHOTO_TYPES}),
        CONSTRAINT chk_photo_file_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT chk_photo_file_size CHECK (byte_size > 0 AND width > 0 AND height > 0),
        CONSTRAINT chk_photo_file_year CHECK (upload_year BETWEEN 2000 AND 2999)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_photo_file_year_center ON photo_file (upload_year, cost_center_id)');
    await queryRunner.query('CREATE INDEX idx_photo_file_origin_asset ON photo_file (origin_asset_id)');

    await queryRunner.query(`
      CREATE TABLE photo_staged_upload (
        id              UUID PRIMARY KEY,
        storage_driver  VARCHAR(20) NOT NULL,
        storage_key     VARCHAR(1024) NOT NULL,
        sha256          VARCHAR(64) NOT NULL,
        content_type    VARCHAR(40) NOT NULL,
        byte_size       INTEGER NOT NULL,
        width           INTEGER NOT NULL,
        height          INTEGER NOT NULL,
        uploaded_by     UUID NOT NULL REFERENCES app_user(id),
        uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalized_at    TIMESTAMPTZ,
        CONSTRAINT uq_photo_staged_upload_key UNIQUE (storage_key),
        CONSTRAINT chk_photo_staged_upload_driver CHECK (storage_driver IN ${DRIVERS}),
        CONSTRAINT chk_photo_staged_upload_content_type CHECK (content_type IN ${PHOTO_TYPES}),
        CONSTRAINT chk_photo_staged_upload_size CHECK (byte_size > 0 AND width > 0 AND height > 0)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_photo_staged_upload_uploaded_at ON photo_staged_upload (uploaded_at)');

    await queryRunner.query(`
      ALTER TABLE asset_photo
        ADD COLUMN file_id UUID REFERENCES photo_file(id),
        ADD COLUMN linked_by UUID REFERENCES app_user(id),
        ADD COLUMN unlinked_at TIMESTAMPTZ,
        ALTER COLUMN file_url DROP NOT NULL,
        ADD CONSTRAINT chk_asset_photo_source CHECK ((file_id IS NULL) <> (file_url IS NULL)),
        ADD CONSTRAINT chk_asset_photo_unlinked_not_primary CHECK (unlinked_at IS NULL OR NOT is_primary)
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_asset_photo_active_file ON asset_photo (asset_id, file_id) WHERE file_id IS NOT NULL AND unlinked_at IS NULL',
    );
    await queryRunner.query('CREATE INDEX idx_asset_photo_file ON asset_photo (file_id) WHERE file_id IS NOT NULL');

    await queryRunner.query(PHOTO_REPORT_VIEW);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [blockers] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM photo_file)::int AS files,
             (SELECT count(*) FROM photo_staged_upload)::int AS staged,
             (SELECT count(*) FROM asset_photo WHERE file_id IS NOT NULL OR unlinked_at IS NOT NULL)::int AS links
    `)) as Array<{ files: number; staged: number; links: number }>;
    if (blockers && (blockers.files > 0 || blockers.staged > 0 || blockers.links > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${blockers.files} fotos guardadas, ` +
          `${blockers.staged} fotos pendientes y ${blockers.links} vínculos de fotos con activos`,
      );
    }
    await queryRunner.query('DROP VIEW v_asset_report');
    await queryRunner.query(ORIGINAL_REPORT_VIEW);
    await queryRunner.query('DROP INDEX idx_asset_photo_file');
    await queryRunner.query('DROP INDEX uq_asset_photo_active_file');
    await queryRunner.query(`
      ALTER TABLE asset_photo
        DROP CONSTRAINT chk_asset_photo_unlinked_not_primary,
        DROP CONSTRAINT chk_asset_photo_source,
        ALTER COLUMN file_url SET NOT NULL,
        DROP COLUMN unlinked_at,
        DROP COLUMN linked_by,
        DROP COLUMN file_id
    `);
    await queryRunner.query('DROP TABLE photo_staged_upload');
    await queryRunner.query('DROP TABLE photo_file');
  }
}
