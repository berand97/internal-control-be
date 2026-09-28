import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Separación de funciones en las actas y proceso de traslado de activos (OCI-17-89).
 *
 * 1. document_signature_reassignment.source: 'REASSIGNED' (reasignación posterior, POST
 *    /documents/:id/signatures/:order/reassign) o 'AT_ISSUE' (sustitución de un turno de Control Interno al emitir el
 *    acta porque el designado ocupaba otra firma). Una sola bitácora de quién terminó en cada turno y por qué; las
 *    filas existentes quedan 'REASSIGNED'. AT_ISSUE no reemite PDF: previous_pdf_hash queda NULL.
 * 2. asset_transfer_reason: catálogo administrable de motivos del traslado. Semilla: solo el motivo que trae el
 *    formato institucional (docs/acta de traslado de activos fijos mdf.xlsx, columna «Razon», celdas Q14:Q26 =
 *    «Reubicacion»); el Excel no tiene lista de validación para esa columna, el resto lo define Control Interno.
 * 3. asset_transfer / asset_transfer_item: el traslado (DRAFT → PENDING_SIGNATURES → COMPLETED | REJECTED |
 *    CANCELLED). Un activo está a lo sumo en un traslado abierto (uq_asset_transfer_item_open). asset_request_id
 *    queda sin FK hasta que exista la solicitud de activos (BE-2).
 * 4. Permisos:
 *    - transfer_catalog:manage:global («Motivos de traslado»): administrar el catálogo; solo INTERNAL_CONTROL_DIRECTOR
 *      (mismo criterio que inventory_catalog:manage:global y 1767225895000: el SUPER_ADMIN no opera catálogos).
 *    - transfer:sign_accounting:global («Firmar actas de traslado por Contabilidad»): quién puede firmar el turno
 *      CONTABILIDAD del OCI-17-89 (la persona se toma de los usuarios activos con este permiso vigente).
 *    - transfer:read:global («Ver traslados y sus actas»): lectura de todos los traslados sin permisos de activos.
 * 5. Rol CONTABILIDAD («Contabilidad», sistema, asignable, sin usuarios): solo transfer:sign_accounting:global y
 *    transfer:read:global; nada de asset:*, inventory:* ni loan:*. Nivel 2 con superior INTERNAL_CONTROL_DIRECTOR,
 *    igual que AUDITOR y DEPARTMENT_HEAD (roles de segundo nivel bajo la directora, 1767225616000/1767225617000);
 *    sin rol padre (no hereda permisos). El SUPER_ADMIN lo otorga a los usuarios de Contabilidad.
 */

const REASON_CATALOG_PERMISSION = 'transfer_catalog:manage:global';
const ACCOUNTING_PERMISSION = 'transfer:sign_accounting:global';
const TRANSFER_READ_PERMISSION = 'transfer:read:global';
const ACCOUNTING_ROLE = 'CONTABILIDAD';

export class AssetTransfersAndSignerSeparation1767225920000 implements MigrationInterface {
  name = 'AssetTransfersAndSignerSeparation1767225920000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_signature_reassignment
        ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'REASSIGNED',
        ADD CONSTRAINT chk_document_signature_reassignment_source CHECK (source IN ('REASSIGNED', 'AT_ISSUE'))
    `);

    await queryRunner.query(`
      CREATE TABLE asset_transfer_reason (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code         VARCHAR(40) NOT NULL,
        name         VARCHAR(120) NOT NULL,
        description  TEXT,
        is_active    BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_by   UUID REFERENCES app_user(id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by   UUID REFERENCES app_user(id),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_asset_transfer_reason_code UNIQUE (code),
        CONSTRAINT chk_asset_transfer_reason_code CHECK (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
        CONSTRAINT chk_asset_transfer_reason_name CHECK (length(btrim(name)) > 0)
      )
    `);
    await queryRunner.query(`
      INSERT INTO asset_transfer_reason (code, name, description, sort_order)
      VALUES ('REUBICACION', 'Reubicación',
        'Motivo del formato institucional OCI-17-89 (columna Razon del Excel: «Reubicacion»)', 1)
    `);

    await queryRunner.query(`
      CREATE TABLE asset_transfer (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status                 VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        source_cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
        target_cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
        requester_person_id    UUID NOT NULL REFERENCES person(id),
        owner_person_id        UUID NOT NULL REFERENCES person(id),
        control_person_id      UUID REFERENCES person(id),
        accounting_person_id   UUID REFERENCES person(id),
        justification          TEXT NOT NULL,
        asset_request_id       UUID,
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
        CONSTRAINT chk_asset_transfer_status
          CHECK (status IN ('DRAFT', 'PENDING_SIGNATURES', 'COMPLETED', 'REJECTED', 'CANCELLED')),
        CONSTRAINT chk_asset_transfer_centers CHECK (source_cost_center_id <> target_cost_center_id),
        CONSTRAINT chk_asset_transfer_justification CHECK (length(btrim(justification)) >= 3),
        CONSTRAINT chk_asset_transfer_generated
          CHECK (status IN ('DRAFT', 'CANCELLED') OR document_request_id IS NOT NULL),
        CONSTRAINT chk_asset_transfer_completed CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
        CONSTRAINT chk_asset_transfer_rejected CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL)),
        CONSTRAINT chk_asset_transfer_cancelled
          CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)),
        CONSTRAINT uq_asset_transfer_document UNIQUE (document_id),
        CONSTRAINT uq_asset_transfer_request UNIQUE (document_request_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_asset_transfer_status ON asset_transfer (status, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_asset_transfer_source ON asset_transfer (source_cost_center_id)');
    await queryRunner.query('CREATE INDEX idx_asset_transfer_target ON asset_transfer (target_cost_center_id)');
    await queryRunner.query('CREATE INDEX idx_asset_transfer_request_ref ON asset_transfer (asset_request_id)');
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_transfer_touch BEFORE UPDATE ON asset_transfer
        FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()
    `);
    await queryRunner.query(`
      CREATE TABLE asset_transfer_item (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transfer_id           UUID NOT NULL REFERENCES asset_transfer(id),
        asset_id              UUID NOT NULL REFERENCES asset(id),
        line_number           SMALLINT NOT NULL,
        physical_condition    asset_physical_condition NOT NULL,
        physically_verified   BOOLEAN NOT NULL DEFAULT FALSE,
        verification_note     TEXT,
        numbering_present     BOOLEAN NOT NULL DEFAULT FALSE,
        reason_id             UUID NOT NULL REFERENCES asset_transfer_reason(id),
        observations          TEXT,
        open                  BOOLEAN NOT NULL DEFAULT TRUE,
        movement_id           UUID REFERENCES asset_movement(id),
        CONSTRAINT uq_asset_transfer_item_asset UNIQUE (transfer_id, asset_id),
        CONSTRAINT uq_asset_transfer_item_line UNIQUE (transfer_id, line_number),
        CONSTRAINT uq_asset_transfer_item_movement UNIQUE (movement_id)
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_asset_transfer_item_open ON asset_transfer_item (asset_id) WHERE open');
    await queryRunner.query('CREATE INDEX idx_asset_transfer_item_asset ON asset_transfer_item (asset_id)');
    await queryRunner.query('CREATE INDEX idx_asset_transfer_item_reason ON asset_transfer_item (reason_id)');

    await queryRunner.query(
      `
      INSERT INTO permission
        (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES
        ($1, 'ASSET', 'transfer_catalog', 'Motivos de traslado', 'manage', 'GLOBAL',
         'Administrar el catálogo de motivos del traslado de activos (OCI-17-89)', TRUE),
        ($2, 'ASSET', 'transfer', 'Traslados de activos', 'sign_accounting', 'GLOBAL',
         'Firmar actas de traslado por Contabilidad', TRUE),
        ($3, 'ASSET', 'transfer', 'Traslados de activos', 'read', 'GLOBAL', 'Ver traslados y sus actas', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [REASON_CATALOG_PERMISSION, ACCOUNTING_PERMISSION, TRANSFER_READ_PERMISSION],
    );
    await queryRunner.query(
      `
      INSERT INTO role (code, name, description, is_system, is_assignable, hierarchy_level, superior_role_id)
      SELECT $1, 'Contabilidad', 'Revisa y firma por Contabilidad las actas de traslado de activos (OCI-17-89)', TRUE, TRUE, 2,
             (SELECT id FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR' AND deleted_at IS NULL)
      ON CONFLICT (code) DO NOTHING
    `,
      [ACCOUNTING_ROLE],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = ANY($2)
      WHERE r.code = $1 AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [ACCOUNTING_ROLE, [ACCOUNTING_PERMISSION, TRANSFER_READ_PERMISSION]],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = $1
      WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR' AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [REASON_CATALOG_PERMISSION],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [assigned] = (await queryRunner.query(
      `SELECT count(*)::int AS total FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE r.code = $1`,
      [ACCOUNTING_ROLE],
    )) as Array<{ total: number }>;
    if ((assigned?.total ?? 0) > 0) {
      throw new Error(`No se puede revertir: el rol ${ACCOUNTING_ROLE} tiene ${assigned?.total} asignaciones de usuario`);
    }
    const [row] = (await queryRunner.query(
      `SELECT (SELECT count(*)::int FROM asset_transfer) AS transfers,
              (SELECT count(*)::int FROM document_signature_reassignment WHERE source = 'AT_ISSUE') AS substitutions,
              (SELECT count(*)::int FROM asset_transfer_reason WHERE code <> 'REUBICACION') AS reasons`,
    )) as Array<{ transfers: number; substitutions: number; reasons: number }>;
    if ((row?.transfers ?? 0) > 0 || (row?.substitutions ?? 0) > 0 || (row?.reasons ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row?.transfers} traslados, ${row?.substitutions} sustituciones de firmante al emitir, ${row?.reasons} motivos de traslado creados`,
      );
    }
    const permissions = [REASON_CATALOG_PERMISSION, ACCOUNTING_PERMISSION, TRANSFER_READ_PERMISSION];
    await queryRunner.query(
      `DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = ANY($1))`,
      [permissions],
    );
    await queryRunner.query('DELETE FROM role_permission WHERE role_id IN (SELECT id FROM role WHERE code = $1)', [ACCOUNTING_ROLE]);
    await queryRunner.query('DELETE FROM role WHERE code = $1', [ACCOUNTING_ROLE]);
    await queryRunner.query('DELETE FROM permission WHERE code = ANY($1)', [permissions]);
    await queryRunner.query('DROP TABLE asset_transfer_item');
    await queryRunner.query('DROP TABLE asset_transfer');
    await queryRunner.query('DROP TABLE asset_transfer_reason');
    await queryRunner.query(`
      ALTER TABLE document_signature_reassignment
        DROP CONSTRAINT chk_document_signature_reassignment_source,
        DROP COLUMN source
    `);
  }
}
