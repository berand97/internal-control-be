import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ExcelStaging1767225626000 implements MigrationInterface {
  name = 'ExcelStaging1767225626000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE staging_batch (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_kind  VARCHAR(40) NOT NULL,
        file_name    VARCHAR(255) NOT NULL,
        file_sha256  CHAR(64) NOT NULL,
        file_size    BIGINT NOT NULL,
        sheets       JSONB NOT NULL,
        loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        loaded_by    UUID REFERENCES app_user(id),
        CONSTRAINT chk_staging_batch_kind
          CHECK (source_kind IN ('ASSET_REPORT', 'COST_CENTERS', 'EMPLOYEE_CONTRACTS')),
        CONSTRAINT uq_staging_batch_file UNIQUE (source_kind, file_sha256)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE staging_row (
        batch_id    UUID NOT NULL REFERENCES staging_batch(id) ON DELETE CASCADE,
        sheet_name  VARCHAR(100) NOT NULL,
        row_number  INTEGER NOT NULL,
        cells       JSONB NOT NULL,
        cell_types  JSONB NOT NULL,
        PRIMARY KEY (batch_id, sheet_name, row_number)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE staging_issue (
        id           BIGSERIAL PRIMARY KEY,
        batch_id     UUID NOT NULL REFERENCES staging_batch(id) ON DELETE CASCADE,
        sheet_name   VARCHAR(100) NOT NULL,
        row_number   INTEGER,
        column_name  VARCHAR(100),
        issue_code   VARCHAR(40) NOT NULL,
        raw_value    TEXT,
        detail       TEXT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_staging_issue_batch ON staging_issue (batch_id, issue_code)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      'SELECT count(*)::int AS count FROM staging_batch',
    )) as Array<{ count: number }>;
    if ((row?.count ?? 0) > 0) {
      throw new Error(
        `staging_batch tiene ${row?.count} lotes; bórralos explícitamente antes de revertir`,
      );
    }
    await queryRunner.query('DROP TABLE staging_issue');
    await queryRunner.query('DROP TABLE staging_row');
    await queryRunner.query('DROP TABLE staging_batch');
  }
}
