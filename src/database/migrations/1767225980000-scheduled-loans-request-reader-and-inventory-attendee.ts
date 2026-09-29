import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Préstamos programados, lectura de solicitudes, vencimiento de las devueltas y quién atendió la toma física.
 *
 * 1. asset_loan.start_date (DATE, NULL): fecha desde la que se puede entregar un préstamo. La pone la generación desde
 *    una solicitud de activos TEMPORARY (asset_request.start_date); los préstamos existentes y los directos
 *    (POST /loans) quedan NULL y se entregan como antes. Generar ya no entrega: el préstamo nace APPROVED con sus
 *    ítems y la entrega (POST /loans/:id/deliver: activos ON_LOAN, movimiento LOAN y acta OCI-01-65) se hace desde esa
 *    fecha.
 * 2. asset_request.status LOAN_SCHEDULED: la solicitud TEMPORARY generó su préstamo, que espera la entrega. Pasa a
 *    DOCUMENT_GENERATED cuando se entrega (el acta OCI-01-65 se encola ahí). Mismas condiciones que DOCUMENT_GENERATED
 *    (aceptada, loan_id sin transfer_id).
 * 3. RETURNED también vence: expires_at obligatorio en ACCEPTED y RETURNED (mismo plazo de 14 días, contado desde la
 *    devolución). Las RETURNED existentes reciben la fecha de su último evento RETURNED (o decided_at) + 14 días; si ya
 *    pasó, el job las vence en su siguiente corrida. El índice parcial de vencimiento cubre ambos estados.
 * 4. Permisos asset_request:read:global («Solicitudes de activos» / read, GLOBAL: ver todas, sin acciones), sembrado a
 *    AUDITOR (la Dirección de Control Interno ya las lee todas con asset_request:review:global), y
 *    asset_request:read:own (OWN: ver las propias; no da nada que el servicio no diera ya por ser parte), sembrado a los
 *    roles que tienen loan:request:own. El menú «Solicitudes de activos» pasa a asset_request / read: lo ven quien
 *    lee todas, quien revisa (review cuenta como lectura en el menú, action-satisfies.ts) y quien solicita (read:own).
 * 5. physical_inventory.attended_by_person_id (FK person, NULL) + attended_recorded_at / attended_recorded_by: el jefe
 *    vigente del centro de la toma que la atendió en sitio; firma el acta OCI-21-37 como ENCARGADO (turno RESPONSABLE).
 *
 * down(): se niega si hay solicitudes LOAN_SCHEDULED; deja las RETURNED sin vencimiento, quita lo sembrado y las
 * columnas (la fecha de inicio de un préstamo de solicitud sigue en asset_request.start_date).
 */

const READ_GLOBAL = 'asset_request:read:global';
const READ_OWN = 'asset_request:read:own';
const REQUESTS_NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000019301';
const EXPIRY_DAYS = 14;

export class ScheduledLoansRequestReaderAndInventoryAttendee1767225980000 implements MigrationInterface {
  name = 'ScheduledLoansRequestReaderAndInventoryAttendee1767225980000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE asset_loan ADD COLUMN start_date DATE');

    await queryRunner.query(`
      ALTER TABLE asset_request
        DROP CONSTRAINT chk_asset_request_status,
        DROP CONSTRAINT chk_asset_request_accepted,
        DROP CONSTRAINT chk_asset_request_expiry,
        DROP CONSTRAINT chk_asset_request_document
    `);
    await queryRunner.query(
      `
      UPDATE asset_request r SET expires_at = coalesce(
        (SELECT max(e.created_at) FROM asset_request_event e WHERE e.request_id = r.id AND e.event_type = 'RETURNED'),
        r.decided_at, r.updated_at) + make_interval(days => $1)
      WHERE r.status = 'RETURNED' AND r.expires_at IS NULL
    `,
      [EXPIRY_DAYS],
    );
    await queryRunner.query(`
      ALTER TABLE asset_request
        ADD CONSTRAINT chk_asset_request_status CHECK (status IN
          ('REQUESTED', 'ACCEPTED', 'CLOSED_BY_OWNER', 'RETURNED', 'LOAN_SCHEDULED', 'DOCUMENT_GENERATED', 'CANCELLED', 'EXPIRED')),
        ADD CONSTRAINT chk_asset_request_accepted CHECK (
          status NOT IN ('ACCEPTED', 'LOAN_SCHEDULED', 'DOCUMENT_GENERATED', 'EXPIRED') OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
        ADD CONSTRAINT chk_asset_request_expiry CHECK (status NOT IN ('ACCEPTED', 'RETURNED') OR expires_at IS NOT NULL),
        ADD CONSTRAINT chk_asset_request_document CHECK (
          (status <> 'LOAN_SCHEDULED' OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL))
          AND (status <> 'DOCUMENT_GENERATED'
            OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL)
            OR (kind = 'PERMANENT' AND transfer_id IS NOT NULL AND loan_id IS NULL)))
    `);
    await queryRunner.query('DROP INDEX idx_asset_request_expiry');
    await queryRunner.query(
      `CREATE INDEX idx_asset_request_expiry ON asset_request (expires_at) WHERE status IN ('ACCEPTED', 'RETURNED')`,
    );

    await queryRunner.query(
      `
      INSERT INTO permission (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES
        ($1, 'ASSET', 'asset_request', 'Solicitudes de activos', 'read', 'GLOBAL',
          'Ver todas las solicitudes de activos, sin decidir, devolver ni generar', TRUE),
        ($2, 'ASSET', 'asset_request', 'Solicitudes de activos', 'read', 'OWN',
          'Ver las solicitudes de activos en las que se es parte (solicitante o jefe del centro dueño)', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [READ_GLOBAL, READ_OWN],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r JOIN permission p ON p.code = $1
      WHERE r.code = 'AUDITOR' AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [READ_GLOBAL],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT DISTINCT rp.role_id, p.id
      FROM role_permission rp
      JOIN permission lp ON lp.id = rp.permission_id AND lp.code = 'loan:request:own'
      JOIN role r ON r.id = rp.role_id AND r.deleted_at IS NULL
      JOIN permission p ON p.code = $1
      ON CONFLICT DO NOTHING
    `,
      [READ_OWN],
    );
    await queryRunner.query(
      `UPDATE navigation_item SET resource = 'asset_request', required_action = 'read' WHERE id = $1`,
      [REQUESTS_NAV_ID],
    );

    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN attended_by_person_id UUID REFERENCES person(id),
        ADD COLUMN attended_recorded_at TIMESTAMPTZ,
        ADD COLUMN attended_recorded_by UUID REFERENCES app_user(id),
        ADD CONSTRAINT chk_physical_inventory_attended CHECK (
          attended_by_person_id IS NULL OR (attended_recorded_at IS NOT NULL AND attended_recorded_by IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT count(*)::int AS total FROM asset_request WHERE status = 'LOAN_SCHEDULED'`,
    )) as Array<{ total: number }>;
    if ((row?.total ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder datos: hay ${row?.total} solicitudes con préstamo programado (LOAN_SCHEDULED)`);
    }
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        DROP CONSTRAINT chk_physical_inventory_attended,
        DROP COLUMN attended_recorded_by,
        DROP COLUMN attended_recorded_at,
        DROP COLUMN attended_by_person_id
    `);
    await queryRunner.query(
      `UPDATE navigation_item SET resource = 'loan', required_action = 'request' WHERE id = $1`,
      [REQUESTS_NAV_ID],
    );
    await queryRunner.query(
      'DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = ANY($1))',
      [[READ_GLOBAL, READ_OWN]],
    );
    await queryRunner.query('DELETE FROM permission WHERE code = ANY($1)', [[READ_GLOBAL, READ_OWN]]);

    await queryRunner.query('DROP INDEX idx_asset_request_expiry');
    await queryRunner.query(
      `CREATE INDEX idx_asset_request_expiry ON asset_request (expires_at) WHERE status = 'ACCEPTED'`,
    );
    await queryRunner.query(`
      ALTER TABLE asset_request
        DROP CONSTRAINT chk_asset_request_status,
        DROP CONSTRAINT chk_asset_request_accepted,
        DROP CONSTRAINT chk_asset_request_expiry,
        DROP CONSTRAINT chk_asset_request_document
    `);
    await queryRunner.query(`UPDATE asset_request SET expires_at = NULL WHERE status = 'RETURNED'`);
    await queryRunner.query(`
      ALTER TABLE asset_request
        ADD CONSTRAINT chk_asset_request_status CHECK (status IN
          ('REQUESTED', 'ACCEPTED', 'CLOSED_BY_OWNER', 'RETURNED', 'DOCUMENT_GENERATED', 'CANCELLED', 'EXPIRED')),
        ADD CONSTRAINT chk_asset_request_accepted CHECK (
          status NOT IN ('ACCEPTED', 'DOCUMENT_GENERATED', 'EXPIRED') OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
        ADD CONSTRAINT chk_asset_request_expiry CHECK (status <> 'ACCEPTED' OR expires_at IS NOT NULL),
        ADD CONSTRAINT chk_asset_request_document CHECK (
          status <> 'DOCUMENT_GENERATED'
          OR (kind = 'TEMPORARY' AND loan_id IS NOT NULL AND transfer_id IS NULL)
          OR (kind = 'PERMANENT' AND transfer_id IS NOT NULL AND loan_id IS NULL))
    `);
    await queryRunner.query('ALTER TABLE asset_loan DROP COLUMN start_date');
  }
}
