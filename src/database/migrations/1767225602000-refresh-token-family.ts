import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshTokenFamily1767225602000 implements MigrationInterface {
  name = 'RefreshTokenFamily1767225602000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
CREATE TYPE refresh_token_family_status AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE refresh_token_family (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    status      refresh_token_family_status NOT NULL DEFAULT 'ACTIVE',
    current_jti UUID NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_refresh_token_family_active_jti
    ON refresh_token_family(current_jti) WHERE status = 'ACTIVE';
CREATE INDEX idx_refresh_token_family_user
    ON refresh_token_family(user_id, status);

CREATE TRIGGER trg_refresh_token_family_touch BEFORE UPDATE ON refresh_token_family
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
DROP TABLE IF EXISTS refresh_token_family CASCADE;
DROP TYPE IF EXISTS refresh_token_family_status;
`);
  }
}
