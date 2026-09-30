import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 1. Retiro del rol CUSTODIAN («Custodio de Activos»). Las dos figuras reales siguen: el jefe de la dependencia (rol
 *    DEPARTMENT_HEAD y jefatura vigente) y el responsable de un activo (asset.current_responsible_id, quien firmó
 *    «Recibe»). El rol RBAC no lo asigna nadie y ninguna regla del código lo exige; DEPARTMENT_HEAD heredaba de él.
 *    En una transacción (la de la migración):
 *    a. cada rol que hereda de CUSTODIAN (DEPARTMENT_HEAD) recibe como propios los permisos que hoy le llegan por esa
 *       herencia y no tiene ya (con sus condiciones): nadie pierde un permiso;
 *    b. esos roles pasan a heredar del padre de CUSTODIAN (VIEWER), y los que lo tenían como superior pasan al
 *       superior de CUSTODIAN;
 *    c. se borran las reglas de separación de funciones que lo citan (la DYNAMIC CUSTODIAN ↔ DEPARTMENT_HEAD solo se
 *       mostraba; «quien solicita un préstamo no lo aprueba» la exige el código con loan.requestedBy);
 *    d. se borran sus role_permission y el rol.
 *    Si algún usuario tiene o tuvo el rol (user_role, aun revocado) la migración se detiene sin tocar nada.
 *    Lo que había queda en audit_log (ROLE_DELETED, entidad ROLE, sin datos personales): la fila del rol, sus
 *    permisos, sus reglas, sus herederos y subordinados, y los permisos copiados. down() lo restaura tal cual desde
 *    ahí (mismo id) y borra ese registro.
 *
 * 2. Categorías de hallazgo sin «pendiente de definir». pending_definition sale del catálogo: ANI se eliminó
 *    (1767225990000) y ninguna categoría queda sin definición. Se borra la columna para que no quede un dato sin
 *    efecto. Si alguna fila estuviera en TRUE (creada o editada desde el catálogo después de 1767225990000), primero se
 *    desactiva: antes no se sugería ni se asignaba, y así sigue. down() vuelve a crear la columna en FALSE (valor de
 *    todas las filas después de 1767225990000); no puede saber cuáles se desactivaron por estar pendientes, esas
 *    quedan inactivas.
 *
 * 3. Menú «Precio cero» (/assets/price-zero) en Activos, junto a «Activos»: lo publica asset:read (la lista de trabajo
 *    GET /assets/price-zero se acota al alcance de lectura de activos). Id fijo y ON CONFLICT (path) DO NOTHING; down()
 *    borra por ese id y nunca toca una fila creada a mano.
 */

const RETIRED_ROLE = 'CUSTODIAN';

const PRICE_ZERO_NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000020101';

export class CustodianRetirementLoanCancelAndSurplusCenter1767226010000 implements MigrationInterface {
  name = 'CustodianRetirementLoanCancelAndSurplusCenter1767226010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.retireCustodian(queryRunner);

    await queryRunner.query(
      'UPDATE inventory_finding_category SET is_active = FALSE, updated_at = NOW() WHERE pending_definition AND is_active',
    );
    await queryRunner.query('ALTER TABLE inventory_finding_category DROP COLUMN pending_definition');

    await queryRunner.query(
      `INSERT INTO navigation_item (id, module, module_label, resource, path, label, required_action, sort_order, icon)
       VALUES ($1, 'ASSET', 'Activos', 'asset', '/assets/price-zero', 'Precio cero', 'read', 71, 'calculator')
       ON CONFLICT (path) DO NOTHING`,
      [PRICE_ZERO_NAV_ID],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM navigation_item WHERE id = $1', [PRICE_ZERO_NAV_ID]);

    await queryRunner.query(
      'ALTER TABLE inventory_finding_category ADD COLUMN pending_definition BOOLEAN NOT NULL DEFAULT FALSE',
    );

    await this.restoreCustodian(queryRunner);
  }

  private async retireCustodian(queryRunner: QueryRunner): Promise<void> {
    const [role] = (await queryRunner.query('SELECT id FROM role WHERE code = $1', [RETIRED_ROLE])) as Array<{
      id: string;
    }>;
    if (!role) {
      return;
    }
    const [assigned] = (await queryRunner.query('SELECT count(*)::int AS total FROM user_role WHERE role_id = $1', [
      role.id,
    ])) as Array<{ total: number }>;
    if ((assigned?.total ?? 0) > 0) {
      throw new Error(
        `No se retira el rol ${RETIRED_ROLE}: tiene ${assigned?.total} asignaciones (vigentes o revocadas). Reasígnelas y decida qué hacer con su historial primero`,
      );
    }
    const [snapshot] = (await queryRunner.query(
      `SELECT to_jsonb(r) AS role,
              coalesce((SELECT jsonb_agg(to_jsonb(rp) ORDER BY rp.permission_id) FROM role_permission rp WHERE rp.role_id = r.id), '[]') AS permissions,
              coalesce((SELECT jsonb_agg(p.code ORDER BY p.code) FROM role_permission rp JOIN permission p ON p.id = rp.permission_id
                        WHERE rp.role_id = r.id), '[]') AS "permissionCodes",
              coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM role_separation_of_duties s
                        WHERE s.role_a_id = r.id OR s.role_b_id = r.id), '[]') AS "sodRules",
              coalesce((SELECT jsonb_agg(c.id ORDER BY c.id) FROM role c WHERE c.parent_role_id = r.id), '[]') AS heirs,
              coalesce((SELECT jsonb_agg(c.id ORDER BY c.id) FROM role c WHERE c.superior_role_id = r.id), '[]') AS subordinates
       FROM role r WHERE r.id = $1`,
      [role.id],
    )) as Array<Record<string, unknown>>;

    // a. Lo heredado pasa a ser propio en cada heredero (solo lo que no tenía).
    const copied = (await queryRunner.query(
      `INSERT INTO role_permission (role_id, permission_id, conditions)
       SELECT heir.id, rp.permission_id, rp.conditions
       FROM role heir JOIN role_permission rp ON rp.role_id = $1
       WHERE heir.parent_role_id = $1
         AND NOT EXISTS (SELECT 1 FROM role_permission own WHERE own.role_id = heir.id AND own.permission_id = rp.permission_id)
       RETURNING role_id AS "roleId", permission_id AS "permissionId"`,
      [role.id],
    )) as Array<{ roleId: string; permissionId: string }>;

    // b. Herencia y jerarquía saltan al padre y al superior del rol retirado.
    await queryRunner.query(
      `UPDATE role heir SET parent_role_id = r.parent_role_id, updated_at = NOW()
       FROM role r WHERE r.id = $1 AND heir.parent_role_id = r.id`,
      [role.id],
    );
    await queryRunner.query(
      `UPDATE role sub SET superior_role_id = r.superior_role_id, updated_at = NOW()
       FROM role r WHERE r.id = $1 AND sub.superior_role_id = r.id`,
      [role.id],
    );

    // c y d.
    await queryRunner.query('DELETE FROM role_separation_of_duties WHERE role_a_id = $1 OR role_b_id = $1', [role.id]);
    await queryRunner.query('DELETE FROM role_permission WHERE role_id = $1', [role.id]);
    await queryRunner.query('DELETE FROM role WHERE id = $1', [role.id]);

    await queryRunner.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, changes)
       VALUES ('ROLE', $1, 'ROLE_DELETED', $2::jsonb)`,
      [
        role.id,
        JSON.stringify({
          code: RETIRED_ROLE,
          migration: this.name,
          reason: 'Rol retirado: el responsable de un activo es asset.current_responsible_id y el jefe de la dependencia es DEPARTMENT_HEAD',
          snapshot: { ...snapshot, copiedPermissions: copied },
        }),
      ],
    );
  }

  private async restoreCustodian(queryRunner: QueryRunner): Promise<void> {
    const [present] = (await queryRunner.query('SELECT id FROM role WHERE code = $1', [RETIRED_ROLE])) as Array<{
      id: string;
    }>;
    if (present) {
      return;
    }
    const [entry] = (await queryRunner.query(
      `SELECT id, changes->'snapshot' AS snapshot FROM audit_log
       WHERE entity_type = 'ROLE' AND action = 'ROLE_DELETED' AND changes->>'code' = $1 AND changes->>'migration' = $2
       ORDER BY performed_at DESC, id DESC LIMIT 1`,
      [RETIRED_ROLE, this.name],
    )) as Array<{ id: string; snapshot: Record<string, unknown> } | undefined>;
    if (!entry) {
      throw new Error(`No se puede restaurar el rol ${RETIRED_ROLE}: falta el registro de su retiro en audit_log`);
    }
    const snapshot = JSON.stringify(entry.snapshot);
    await queryRunner.query(
      `INSERT INTO role SELECT * FROM jsonb_populate_record(NULL::role, $1::jsonb->'role')`,
      [snapshot],
    );
    await queryRunner.query(
      `INSERT INTO role_permission SELECT * FROM jsonb_populate_recordset(NULL::role_permission, $1::jsonb->'permissions')`,
      [snapshot],
    );
    await queryRunner.query(
      `INSERT INTO role_separation_of_duties
       SELECT * FROM jsonb_populate_recordset(NULL::role_separation_of_duties, $1::jsonb->'sodRules')`,
      [snapshot],
    );
    await queryRunner.query(
      `UPDATE role SET parent_role_id = ($1::jsonb->'role'->>'id')::uuid, updated_at = NOW()
       WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb->'heirs')::uuid)`,
      [snapshot],
    );
    await queryRunner.query(
      `UPDATE role SET superior_role_id = ($1::jsonb->'role'->>'id')::uuid, updated_at = NOW()
       WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb->'subordinates')::uuid)`,
      [snapshot],
    );
    await queryRunner.query(
      `DELETE FROM role_permission rp
       USING jsonb_to_recordset($1::jsonb->'copiedPermissions') AS c("roleId" uuid, "permissionId" uuid)
       WHERE rp.role_id = c."roleId" AND rp.permission_id = c."permissionId"`,
      [snapshot],
    );
    await queryRunner.query('DELETE FROM audit_log WHERE id = $1', [entry.id]);
  }
}
