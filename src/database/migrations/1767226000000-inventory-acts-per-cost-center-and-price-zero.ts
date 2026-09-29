import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Un acta OCI-21-37 por centro de costo de la toma, y activos con precio de compra cero.
 *
 * 1. physical_inventory_act: una fila por centro de costo presente en los ítems de la toma (esperados por su centro en
 *    la foto; sobrantes por el centro de su activo o del activo creado al resolverlos). La ubicación define el trabajo
 *    de campo, no el acta: al cerrar se resuelve el jefe que firma cada acta como ENCARGADO y al conciliar se encola una
 *    por centro, cada una con su consecutivo. Guarda lo que antes estaba en physical_inventory (signer_head_*,
 *    attended_by_*, act_request_id, act_document_id, act_blocked_*), ahora por acta. «Atendió por el área» pasa a ser
 *    por acta: en una toma por ubicación cada área pudo tener su encargado.
 *    - Datos existentes: cada toma cerrada o conciliada recibe una fila por centro presente en sus ítems (alcance
 *      COST_CENTER: una sola, la de su centro) con lo que tenía la toma. Una toma de otro alcance cuya acta única ya se
 *      encoló (antes de esta regla) conserva esa acta en una fila con cost_center_id NULL: es la única forma de fila sin
 *      centro. El acta y la solicitud del outbox que la generó se reenlazan a la fila (document.entity_type
 *      PHYSICAL_INVENTORY → PHYSICAL_INVENTORY_ACT, entity_id = id de la fila; igual en document_request.payload).
 *    - Las columnas viejas de physical_inventory se eliminan: nada más las usa (el acta y su firmante viven en la fila).
 * 2. asset_price_zero_reason: catálogo administrable de motivos de un precio de compra cero. Nace VACÍO (no se siembra).
 *    asset_price_zero_classification: el motivo registrado para cada activo (uno vigente por activo; quién y cuándo;
 *    los cambios quedan en audit_log). No toca el precio.
 * 3. Marca PRICE_ZERO (data_quality_flags) como la pone la importación de Excel: precio 0 sin PRICE_MISSING. Los activos
 *    existentes con precio 0 sin la marca la reciben (sin tocar precios). Un trigger mantiene la marca al insertar o
 *    cambiar el precio: la pone con precio 0 y la quita cuando el precio deja de ser 0.
 * 4. Permiso asset_price_zero_reason:manage:global («Motivos de precio cero» / manage), sembrado solo a
 *    INTERNAL_CONTROL_DIRECTOR (SUPER_ADMIN sin permisos operativos).
 *
 * down(): se niega si alguna toma tiene más de un acta ya encolada o generada (volver a una por toma perdería el
 * vínculo de las demás) o si hay motivos de precio cero registrados. Devuelve los datos de la única fila de cada toma a
 * physical_inventory y reenlaza sus actas. Las marcas PRICE_ZERO se quedan (el precio sigue siendo 0).
 */

const PERMISSION_CODE = 'asset_price_zero_reason:manage:global';
const ACT_ENTITY = 'PHYSICAL_INVENTORY_ACT';
const LEGACY_ENTITY = 'PHYSICAL_INVENTORY';
const ACT_FORMAT = 'OCI-21-37';

/** Centro al que va cada ítem vigente de la toma (el mismo criterio que InventoryActService). */
const ITEM_CENTERS = `
  SELECT DISTINCT pi.id AS inventory_id,
    CASE WHEN pi.scope_type = 'COST_CENTER' THEN pi.scope_id
         WHEN i.verification_result = 'SURPLUS' THEN coalesce(a.current_cost_center_id, ra.current_cost_center_id)
         ELSE i.expected_cost_center_id END AS cost_center_id
  FROM physical_inventory pi
  JOIN physical_inventory_item i ON i.inventory_id = pi.id AND i.voided_at IS NULL
  LEFT JOIN asset a ON a.id = i.asset_id
  LEFT JOIN asset ra ON ra.id = i.resolved_asset_id
  WHERE pi.status IN ('CLOSED', 'RECONCILED')
`;

export class InventoryActsPerCostCenterAndPriceZero1767226000000 implements MigrationInterface {
  name = 'InventoryActsPerCostCenterAndPriceZero1767226000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE physical_inventory_act (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inventory_id            UUID NOT NULL REFERENCES physical_inventory(id) ON DELETE CASCADE,
        cost_center_id          UUID REFERENCES cost_center(id),
        signer_head_person_id   UUID REFERENCES person(id),
        signer_head_recorded_at TIMESTAMPTZ,
        signer_head_recorded_by UUID REFERENCES app_user(id),
        attended_by_person_id   UUID REFERENCES person(id),
        attended_by_name        VARCHAR(200),
        document_request_id     UUID REFERENCES document_request(id),
        document_id             UUID REFERENCES document(id),
        blocked_code            VARCHAR(40),
        blocked_message         TEXT,
        blocked_at              TIMESTAMPTZ,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_physical_inventory_act_center UNIQUE NULLS NOT DISTINCT (inventory_id, cost_center_id),
        CONSTRAINT chk_physical_inventory_act_signer_head CHECK (
          signer_head_person_id IS NULL OR (signer_head_recorded_at IS NOT NULL AND signer_head_recorded_by IS NOT NULL)),
        CONSTRAINT chk_physical_inventory_act_attended CHECK (
          (attended_by_person_id IS NULL OR attended_by_name IS NULL)
          AND (attended_by_name IS NULL OR length(btrim(attended_by_name)) BETWEEN 3 AND 200)),
        CONSTRAINT chk_physical_inventory_act_blocked CHECK (
          (blocked_code IS NULL) = (blocked_at IS NULL) AND (blocked_code IS NULL OR document_request_id IS NULL)),
        CONSTRAINT chk_physical_inventory_act_legacy CHECK (cost_center_id IS NOT NULL OR document_request_id IS NOT NULL)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_physical_inventory_act_request ON physical_inventory_act (document_request_id)');

    // Tomas de otro alcance cuya acta única ya se encoló: la conservan en una fila sin centro.
    await queryRunner.query(`
      INSERT INTO physical_inventory_act (inventory_id, cost_center_id, signer_head_person_id, signer_head_recorded_at,
        signer_head_recorded_by, attended_by_person_id, attended_by_name, document_request_id, document_id)
      SELECT id, NULL, signer_head_person_id, signer_head_recorded_at, signer_head_recorded_by, attended_by_person_id,
        attended_by_name, act_request_id, act_document_id
      FROM physical_inventory
      WHERE scope_type <> 'COST_CENTER' AND act_request_id IS NOT NULL
    `);
    // Las demás tomas cerradas o conciliadas: una fila por centro presente (COST_CENTER: la de su centro, siempre).
    await queryRunner.query(`
      INSERT INTO physical_inventory_act (inventory_id, cost_center_id, signer_head_person_id, signer_head_recorded_at,
        signer_head_recorded_by, attended_by_person_id, attended_by_name, document_request_id, document_id,
        blocked_code, blocked_message, blocked_at)
      SELECT pi.id, c.cost_center_id,
        CASE WHEN pi.scope_type = 'COST_CENTER' THEN pi.signer_head_person_id END,
        CASE WHEN pi.scope_type = 'COST_CENTER' THEN pi.signer_head_recorded_at END,
        CASE WHEN pi.scope_type = 'COST_CENTER' THEN pi.signer_head_recorded_by END,
        pi.attended_by_person_id, pi.attended_by_name,
        CASE WHEN pi.scope_type = 'COST_CENTER' THEN pi.act_request_id END,
        CASE WHEN pi.scope_type = 'COST_CENTER' THEN pi.act_document_id END,
        CASE WHEN pi.act_request_id IS NULL THEN pi.act_blocked_code END,
        CASE WHEN pi.act_request_id IS NULL THEN pi.act_blocked_message END,
        CASE WHEN pi.act_request_id IS NULL AND pi.act_blocked_code IS NOT NULL THEN coalesce(pi.act_blocked_at, NOW()) END
      FROM physical_inventory pi
      JOIN (
        ${ITEM_CENTERS}
        UNION
        SELECT id, scope_id FROM physical_inventory
        WHERE scope_type = 'COST_CENTER' AND scope_id IS NOT NULL AND status IN ('CLOSED', 'RECONCILED')
      ) c ON c.inventory_id = pi.id AND c.cost_center_id IS NOT NULL
      WHERE pi.status IN ('CLOSED', 'RECONCILED')
        AND NOT (pi.scope_type <> 'COST_CENTER' AND pi.act_request_id IS NOT NULL)
    `);
    // Reenlaza las actas ya encoladas o generadas a su fila.
    await queryRunner.query(
      `
      UPDATE document d SET entity_type = $1, entity_id = a.id
      FROM physical_inventory_act a
      WHERE d.entity_type = $2 AND d.format_key = $3 AND d.entity_id = a.inventory_id AND a.document_request_id IS NOT NULL
    `,
      [ACT_ENTITY, LEGACY_ENTITY, ACT_FORMAT],
    );
    await queryRunner.query(
      `
      UPDATE document_request r
      SET payload = r.payload || jsonb_build_object('entityType', $1::text, 'entityId', a.id::text)
      FROM physical_inventory_act a
      WHERE r.format_key = $3 AND r.payload->>'entityType' = $2 AND r.payload->>'entityId' = a.inventory_id::text
        AND a.document_request_id IS NOT NULL
    `,
      [ACT_ENTITY, LEGACY_ENTITY, ACT_FORMAT],
    );
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        DROP CONSTRAINT chk_physical_inventory_attended,
        DROP CONSTRAINT chk_physical_inventory_signer_head,
        DROP COLUMN attended_by_name,
        DROP COLUMN attended_by_person_id,
        DROP COLUMN signer_head_recorded_by,
        DROP COLUMN signer_head_recorded_at,
        DROP COLUMN signer_head_person_id,
        DROP COLUMN act_blocked_at,
        DROP COLUMN act_blocked_message,
        DROP COLUMN act_blocked_code,
        DROP COLUMN act_document_id,
        DROP COLUMN act_request_id
    `);

    // ---------- Precio de compra cero ----------
    await queryRunner.query(`
      CREATE TABLE asset_price_zero_reason (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label      VARCHAR(120) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_asset_price_zero_reason_label CHECK (length(btrim(label)) >= 3)
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_asset_price_zero_reason_label ON asset_price_zero_reason (lower(btrim(label)))',
    );
    await queryRunner.query(`
      CREATE TABLE asset_price_zero_classification (
        asset_id      UUID PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
        reason_id     UUID NOT NULL REFERENCES asset_price_zero_reason(id),
        note          TEXT,
        classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        classified_by UUID NOT NULL REFERENCES app_user(id),
        CONSTRAINT chk_asset_price_zero_classification_note CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 500)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_asset_price_zero_classification_reason ON asset_price_zero_classification (reason_id)',
    );
    await queryRunner.query(`
      CREATE FUNCTION fn_asset_price_zero_flag() RETURNS trigger AS $$
      BEGIN
        IF NEW.acquisition_price = 0 THEN
          IF NOT (NEW.data_quality_flags && ARRAY['PRICE_ZERO', 'PRICE_MISSING']::VARCHAR(40)[]) THEN
            NEW.data_quality_flags := array_append(NEW.data_quality_flags, 'PRICE_ZERO'::VARCHAR(40));
          END IF;
        ELSE
          NEW.data_quality_flags := array_remove(NEW.data_quality_flags, 'PRICE_ZERO'::VARCHAR(40));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_price_zero_flag BEFORE INSERT OR UPDATE OF acquisition_price, data_quality_flags ON asset
        FOR EACH ROW EXECUTE FUNCTION fn_asset_price_zero_flag()
    `);
    await queryRunner.query(`
      UPDATE asset SET data_quality_flags = array_append(data_quality_flags, 'PRICE_ZERO'::VARCHAR(40))
      WHERE acquisition_price = 0 AND NOT (data_quality_flags && ARRAY['PRICE_ZERO', 'PRICE_MISSING']::VARCHAR(40)[])
    `);

    await queryRunner.query(
      `
      INSERT INTO permission (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES ($1, 'ASSET', 'asset_price_zero_reason', 'Motivos de precio cero', 'manage', 'GLOBAL',
        'Administrar el catálogo de motivos de un precio de compra cero', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [PERMISSION_CODE],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r JOIN permission p ON p.code = $1
      WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR' AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [PERMISSION_CODE],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM (
          SELECT inventory_id FROM physical_inventory_act WHERE document_request_id IS NOT NULL
          GROUP BY inventory_id HAVING count(*) > 1) m)::int AS multi,
        (SELECT count(*) FROM asset_price_zero_classification)::int AS classified
    `)) as Array<{ multi: number; classified: number }>;
    if ((row?.multi ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row?.multi} tomas tienen más de un acta OCI-21-37 encolada (una por centro)`,
      );
    }
    if ((row?.classified ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder datos: hay ${row?.classified} activos con motivo de precio cero`);
    }
    await queryRunner.query(
      'DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = $1)',
      [PERMISSION_CODE],
    );
    await queryRunner.query('DELETE FROM permission WHERE code = $1', [PERMISSION_CODE]);
    await queryRunner.query('DROP TRIGGER trg_asset_price_zero_flag ON asset');
    await queryRunner.query('DROP FUNCTION fn_asset_price_zero_flag()');
    await queryRunner.query('DROP TABLE asset_price_zero_classification');
    await queryRunner.query('DROP TABLE asset_price_zero_reason');

    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN act_request_id      UUID REFERENCES document_request(id),
        ADD COLUMN act_document_id     UUID REFERENCES document(id),
        ADD COLUMN act_blocked_code    VARCHAR(40),
        ADD COLUMN act_blocked_message TEXT,
        ADD COLUMN act_blocked_at      TIMESTAMPTZ,
        ADD COLUMN signer_head_person_id UUID REFERENCES person(id),
        ADD COLUMN signer_head_recorded_at TIMESTAMPTZ,
        ADD COLUMN signer_head_recorded_by UUID REFERENCES app_user(id),
        ADD COLUMN attended_by_person_id UUID REFERENCES person(id),
        ADD COLUMN attended_by_name VARCHAR(200),
        ADD CONSTRAINT chk_physical_inventory_signer_head CHECK (
          signer_head_person_id IS NULL OR (signer_head_recorded_at IS NOT NULL AND signer_head_recorded_by IS NOT NULL)),
        ADD CONSTRAINT chk_physical_inventory_attended CHECK (
          (attended_by_person_id IS NULL OR attended_by_name IS NULL)
          AND (attended_by_name IS NULL OR length(btrim(attended_by_name)) BETWEEN 3 AND 200))
    `);
    // La fila encolada de cada toma (a lo sumo una) o, si ninguna se encoló, la primera por centro. La firma solo vuelve
    // en tomas de un centro (antes solo esas tenían jefe que firmara).
    await queryRunner.query(`
      UPDATE physical_inventory pi SET
        act_request_id = a.document_request_id,
        act_document_id = a.document_id,
        act_blocked_code = a.blocked_code,
        act_blocked_message = a.blocked_message,
        act_blocked_at = a.blocked_at,
        signer_head_person_id = CASE WHEN pi.scope_type = 'COST_CENTER' THEN a.signer_head_person_id END,
        signer_head_recorded_at = CASE WHEN pi.scope_type = 'COST_CENTER' THEN a.signer_head_recorded_at END,
        signer_head_recorded_by = CASE WHEN pi.scope_type = 'COST_CENTER' THEN a.signer_head_recorded_by END,
        attended_by_person_id = a.attended_by_person_id,
        attended_by_name = a.attended_by_name
      FROM (
        SELECT DISTINCT ON (a.inventory_id) a.*
        FROM physical_inventory_act a LEFT JOIN cost_center cc ON cc.id = a.cost_center_id
        ORDER BY a.inventory_id, (a.document_request_id IS NULL), cc.external_code NULLS FIRST, a.id
      ) a
      WHERE a.inventory_id = pi.id
    `);
    await queryRunner.query(
      `
      UPDATE document d SET entity_type = $2, entity_id = a.inventory_id
      FROM physical_inventory_act a
      WHERE d.entity_type = $1 AND d.entity_id = a.id
    `,
      [ACT_ENTITY, LEGACY_ENTITY],
    );
    await queryRunner.query(
      `
      UPDATE document_request r
      SET payload = r.payload || jsonb_build_object('entityType', $2::text, 'entityId', a.inventory_id::text)
      FROM physical_inventory_act a
      WHERE r.payload->>'entityType' = $1 AND r.payload->>'entityId' = a.id::text
    `,
      [ACT_ENTITY, LEGACY_ENTITY],
    );
    await queryRunner.query('DROP TABLE physical_inventory_act');
  }
}
