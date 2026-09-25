import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Acta de entrega y asignación (OCI-01-55): el proceso por el que un activo obtiene responsable.
 * - asset_handover: la entrega (quién recibe, centro de costo, quién firma por Control Interno), la solicitud del
 *   outbox que genera su acta, el acta generada y, al firmarse, el responsable asignado (firmante RECIBE final).
 * - asset_handover_item: cada activo entregado, su observación en el acta y el movimiento ASSIGNMENT que lo aplicó.
 *   uq_asset_handover_item_open impide que un activo esté en dos entregas abiertas (dos actas asignándolo).
 */
export class AssetHandover1767225640000 implements MigrationInterface {
  name = 'AssetHandover1767225640000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE asset_handover (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status               VARCHAR(20) NOT NULL DEFAULT 'AWAITING_DOCUMENT',
        cost_center_id       UUID NOT NULL REFERENCES cost_center(id),
        receiver_person_id   UUID NOT NULL REFERENCES person(id),
        auditor_person_id    UUID NOT NULL REFERENCES person(id),
        assigned_person_id   UUID REFERENCES person(id),
        document_request_id  UUID NOT NULL REFERENCES document_request(id),
        document_id          UUID REFERENCES document(id),
        created_by           UUID NOT NULL REFERENCES app_user(id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at            TIMESTAMPTZ,
        CONSTRAINT chk_asset_handover_status
          CHECK (status IN ('AWAITING_DOCUMENT', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED')),
        CONSTRAINT chk_asset_handover_document
          CHECK (status = 'AWAITING_DOCUMENT' OR document_id IS NOT NULL),
        CONSTRAINT chk_asset_handover_closed
          CHECK ((status IN ('SIGNED', 'REJECTED')) = (closed_at IS NOT NULL)),
        CONSTRAINT chk_asset_handover_assigned
          CHECK ((status = 'SIGNED') = (assigned_person_id IS NOT NULL)),
        CONSTRAINT uq_asset_handover_document UNIQUE (document_id),
        CONSTRAINT uq_asset_handover_request UNIQUE (document_request_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_asset_handover_status ON asset_handover (status, created_at DESC)');
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_handover_touch BEFORE UPDATE ON asset_handover
        FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()
    `);
    await queryRunner.query(`
      CREATE TABLE asset_handover_item (
        handover_id  UUID NOT NULL REFERENCES asset_handover(id),
        asset_id     UUID NOT NULL REFERENCES asset(id),
        line_number  SMALLINT NOT NULL,
        note         TEXT,
        open         BOOLEAN NOT NULL DEFAULT TRUE,
        movement_id  UUID REFERENCES asset_movement(id),
        PRIMARY KEY (handover_id, asset_id),
        CONSTRAINT uq_asset_handover_item_line UNIQUE (handover_id, line_number),
        CONSTRAINT uq_asset_handover_item_movement UNIQUE (movement_id)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_asset_handover_item_open ON asset_handover_item (asset_id) WHERE open');
    await queryRunner.query('CREATE INDEX idx_asset_handover_item_asset ON asset_handover_item (asset_id)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query('SELECT count(*)::int AS handovers FROM asset_handover')) as Array<{
      handovers: number;
    }>;
    if ((row?.handovers ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder datos: ${row?.handovers} entregas de activos registradas`);
    }
    await queryRunner.query('DROP TABLE asset_handover_item');
    await queryRunner.query('DROP TABLE asset_handover');
  }
}
