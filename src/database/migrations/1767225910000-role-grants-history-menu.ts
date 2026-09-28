import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Menú "Historial de permisos" (/roles/grants-history) en Administración, junto a "Roles y permisos". Lo publica
 * role:audit (resource `role`, required_action `audit`): lo ven la Directora de Control Interno, el Auditor y
 * SUPER_ADMIN (migración 1767225900000), aunque no tengan role:read. actionSatisfies no deja que otra acción cubra
 * `audit`, así que administrar roles no lo publica. Ícono `shield`, el de Roles.
 *
 * Id fijo y ON CONFLICT (path) DO NOTHING; down() borra por ese id y nunca toca una fila creada a mano.
 */

const NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000019101';

export class RoleGrantsHistoryMenu1767225910000 implements MigrationInterface {
  name = 'RoleGrantsHistoryMenu1767225910000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO navigation_item
        (id, module, module_label, resource, path, label, required_action, sort_order, icon)
      VALUES
        ('${NAV_ID}', 'USER', 'Administración', 'role', '/roles/grants-history', 'Historial de permisos', 'audit', 21, 'shield')
      ON CONFLICT (path) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM navigation_item WHERE id = '${NAV_ID}'`,
    );
  }
}
