import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Solicitud de activos entre centros de costo (BE-2).
 *
 * 1. asset_request: un jefe vigente del centro que solicita (requesting_cost_center_id, el destino) pide activos al
 *    centro dueño (owner_cost_center_id). Estados (src/modules/asset-requests/domain/asset-request-transitions.ts):
 *    REQUESTED → ACCEPTED | CLOSED_BY_OWNER; ACCEPTED → DOCUMENT_GENERATED | RETURNED | EXPIRED; RETURNED → REQUESTED |
 *    ACCEPTED | CANCELLED; REQUESTED → CANCELLED. Código SOL-<año>-NNNN (code_sequence asset_request). note es texto
 *    libre del solicitante que nunca se valida ni se resuelve contra activos. loan_id / transfer_id: el documento que
 *    generó Control Interno (préstamo si es TEMPORARY, traslado si es PERMANENT).
 * 2. asset_request_item: los activos que eligió el jefe dueño. Un activo está a lo sumo en una solicitud abierta
 *    (uq_asset_request_item_open, como los traslados): la aceptación los reserva hasta que se genera el documento, se
 *    cancela, vence o vuelve al dueño.
 * 3. asset_request_event: historial (evento, actor, motivo, payload sin datos personales). actor_user_id NULL = el
 *    job de vencimiento.
 * 4. asset_loan.asset_request_id (NULL) y la FK que faltaba en asset_transfer.asset_request_id (1767225920000).
 * 5. Permiso asset_request:review:global («Solicitudes de activos» / review): revisar las solicitudes aceptadas
 *    (devolver o generar el documento) y leerlas todas. Sembrado a INTERNAL_CONTROL_DIRECTOR y AUDITOR, los roles de
 *    Control Interno (los mismos que firman por Control Interno, CONTROL_SIGNER_ROLE_CODES).
 * 6. Menú: «Solicitudes de activos» (/asset-requests) con loan:request (lo tienen DEPARTMENT_HEAD, CUSTODIAN e
 *    INTERNAL_CONTROL_DIRECTOR) y «Traslados» (/transfers) con transfer:read. El menú pide un solo recurso+acción
 *    (actionSatisfies): para que quien genera traslados (asset:update:global, solo INTERNAL_CONTROL_DIRECTOR) lo vea,
 *    ese rol recibe también transfer:read:global, que no le da nada que no tuviera con asset:read:global.
 *
 * down(): se niega si hay solicitudes; borra por id fijo los ítems del menú y solo lo que sembró.
 */

const REVIEW_PERMISSION = 'asset_request:review:global';
const TRANSFER_READ_PERMISSION = 'transfer:read:global';
const REVIEW_ROLES = ['INTERNAL_CONTROL_DIRECTOR', 'AUDITOR'];
const REQUESTS_NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000019301';
const TRANSFERS_NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000019302';

export class AssetRequests1767225930000 implements MigrationInterface {
  name = 'AssetRequests1767225930000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE asset_request (
        id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code                       VARCHAR(30) NOT NULL,
        kind                       VARCHAR(20) NOT NULL,
        status                     VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
        requester_user_id          UUID NOT NULL REFERENCES app_user(id),
        requester_person_id        UUID NOT NULL REFERENCES person(id),
        requesting_cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
        owner_cost_center_id       UUID NOT NULL REFERENCES cost_center(id),
        description                TEXT NOT NULL,
        note                       TEXT,
        start_date                 DATE,
        expected_return_date       DATE,
        accepted_by                UUID REFERENCES app_user(id),
        accepted_at                TIMESTAMPTZ,
        decided_by                 UUID REFERENCES app_user(id),
        decided_at                 TIMESTAMPTZ,
        expires_at                 TIMESTAMPTZ,
        loan_id                    UUID REFERENCES asset_loan(id),
        transfer_id                UUID REFERENCES asset_transfer(id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_asset_request_code UNIQUE (code),
        CONSTRAINT uq_asset_request_loan UNIQUE (loan_id),
        CONSTRAINT uq_asset_request_transfer UNIQUE (transfer_id),
        CONSTRAINT chk_asset_request_kind CHECK (kind IN ('TEMPORARY', 'PERMANENT')),
        CONSTRAINT chk_asset_request_status CHECK (status IN
          ('REQUESTED', 'ACCEPTED', 'CLOSED_BY_OWNER', 'RETURNED', 'DOCUMENT_GENERATED', 'CANCELLED', 'EXPIRED')),
        CONSTRAINT chk_asset_request_centers CHECK (requesting_cost_center_id <> owner_cost_center_id),
        CONSTRAINT chk_asset_request_description CHECK (length(btrim(description)) BETWEEN 3 AND 2000),
        CONSTRAINT chk_asset_request_note CHECK (note IS NULL OR length(note) <= 2000),
        CONSTRAINT chk_asset_request_dates CHECK (
          kind = 'PERMANENT'
          OR (start_date IS NOT NULL AND expected_return_date IS NOT NULL AND expected_return_date >= start_date)),
        CONSTRAINT chk_asset_request_accepted CHECK (
          status NOT IN ('ACCEPTED', 'DOCUMENT_GENERATED', 'EXPIRED') OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
        CONSTRAINT chk_asset_request_expiry CHECK (status <> 'ACCEPTED' OR expires_at IS NOT NULL),
        CONSTRAINT chk_asset_request_document CHECK (
          status <> 'DOCUMENT_GENERATED'
          OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL)
          OR (kind = 'PERMANENT' AND transfer_id IS NOT NULL AND loan_id IS NULL))
      )
    `);
    await queryRunner.query('CREATE INDEX idx_asset_request_status ON asset_request (status, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_asset_request_owner ON asset_request (owner_cost_center_id, status)');
    await queryRunner.query('CREATE INDEX idx_asset_request_requesting ON asset_request (requesting_cost_center_id)');
    await queryRunner.query('CREATE INDEX idx_asset_request_requester ON asset_request (requester_user_id, created_at DESC)');
    await queryRunner.query(
      `CREATE INDEX idx_asset_request_expiry ON asset_request (expires_at) WHERE status = 'ACCEPTED'`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_request_touch BEFORE UPDATE ON asset_request
        FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()
    `);

    await queryRunner.query(`
      CREATE TABLE asset_request_item (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id  UUID NOT NULL REFERENCES asset_request(id),
        asset_id    UUID NOT NULL REFERENCES asset(id),
        open        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_asset_request_item_asset UNIQUE (request_id, asset_id)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_asset_request_item_open ON asset_request_item (asset_id) WHERE open');
    await queryRunner.query('CREATE INDEX idx_asset_request_item_asset ON asset_request_item (asset_id)');

    await queryRunner.query(`
      CREATE TABLE asset_request_event (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id     UUID NOT NULL REFERENCES asset_request(id),
        event_type     VARCHAR(40) NOT NULL,
        from_status    VARCHAR(30),
        to_status      VARCHAR(30),
        actor_user_id  UUID REFERENCES app_user(id),
        reason         TEXT,
        payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_asset_request_event_request ON asset_request_event (request_id, created_at)');

    await queryRunner.query('ALTER TABLE asset_loan ADD COLUMN asset_request_id UUID REFERENCES asset_request(id)');
    await queryRunner.query('CREATE UNIQUE INDEX uq_asset_loan_asset_request ON asset_loan (asset_request_id) WHERE asset_request_id IS NOT NULL');
    await queryRunner.query(`
      ALTER TABLE asset_transfer
        ADD CONSTRAINT fk_asset_transfer_asset_request FOREIGN KEY (asset_request_id) REFERENCES asset_request(id)
    `);

    await queryRunner.query(`
      INSERT INTO code_sequence (sequence_name, prefix, current_value, padding_length)
      VALUES ('asset_request', 'SOL-', 0, 4)
      ON CONFLICT (sequence_name) DO NOTHING
    `);

    await queryRunner.query(
      `
      INSERT INTO permission (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES ($1, 'ASSET', 'asset_request', 'Solicitudes de activos', 'review', 'GLOBAL',
        'Revisar las solicitudes de activos aceptadas (devolverlas o generar el préstamo o traslado) y leerlas todas', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [REVIEW_PERMISSION],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r JOIN permission p ON p.code = $1
      WHERE r.code = ANY($2) AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [REVIEW_PERMISSION, REVIEW_ROLES],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r JOIN permission p ON p.code = $1
      WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR' AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [TRANSFER_READ_PERMISSION],
    );

    await queryRunner.query(`
      INSERT INTO navigation_item
        (id, module, module_label, resource, path, label, required_action, sort_order, icon)
      VALUES
        ('${REQUESTS_NAV_ID}', 'ASSET', 'Activos', 'loan', '/asset-requests', 'Solicitudes de activos', 'request', 82, 'hand-helping'),
        ('${TRANSFERS_NAV_ID}', 'ASSET', 'Activos', 'transfer', '/transfers', 'Traslados', 'read', 76, 'package')
      ON CONFLICT (path) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query('SELECT count(*)::int AS total FROM asset_request')) as Array<{ total: number }>;
    if ((row?.total ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder datos: hay ${row?.total} solicitudes de activos`);
    }
    await queryRunner.query(`DELETE FROM navigation_item WHERE id IN ('${REQUESTS_NAV_ID}', '${TRANSFERS_NAV_ID}')`);
    // Lo que sembró up(): transfer:read:global de la Dirección de Control Interno (1767225920000 no se lo daba).
    await queryRunner.query(
      `DELETE FROM role_permission
       WHERE role_id IN (SELECT id FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR')
         AND permission_id = (SELECT id FROM permission WHERE code = $1)`,
      [TRANSFER_READ_PERMISSION],
    );
    await queryRunner.query('DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = $1)', [
      REVIEW_PERMISSION,
    ]);
    await queryRunner.query('DELETE FROM permission WHERE code = $1', [REVIEW_PERMISSION]);
    await queryRunner.query(`DELETE FROM code_sequence WHERE sequence_name = 'asset_request'`);
    await queryRunner.query('ALTER TABLE asset_transfer DROP CONSTRAINT fk_asset_transfer_asset_request');
    await queryRunner.query('DROP INDEX uq_asset_loan_asset_request');
    await queryRunner.query('ALTER TABLE asset_loan DROP COLUMN asset_request_id');
    await queryRunner.query('DROP TABLE asset_request_event');
    await queryRunner.query('DROP TABLE asset_request_item');
    await queryRunner.query('DROP TABLE asset_request');
  }
}
