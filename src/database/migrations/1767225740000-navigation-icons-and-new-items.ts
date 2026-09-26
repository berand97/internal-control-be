import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El ícono del menú pasa a ser dato y el menú sembrado alcanza las pantallas nuevas.
 *
 * - navigation_item.icon: nullable, restringida por CHECK al catálogo cerrado de
 *   src/common/authorization/navigation-icons.ts (copiado aquí literalmente: una migración no importa código vivo).
 * - Relleno: cada ítem existente recibe el ícono que el sidebar le mostraba, deducido de su recurso (RESOURCE_ICONS
 *   del frontend); un recurso sin ícono mostraba `circle` y así queda (hoy: /mail).
 * - /document-templates "Plantillas" pasa a /documents "Documentos" (la ruta vieja solo redirige a /documents),
 *   conservando recurso y acción, solo si el ítem sigue con los valores sembrados y nadie creó ya /documents.
 * - /imports y /handovers se insertan con id fijo y ON CONFLICT (path) DO NOTHING: si un administrador ya creó
 *   esa ruta, se respeta la suya. El down() borra por ese id, así que nunca toca una fila creada a mano.
 */

const ICONS = [
  'users',
  'shield',
  'map-pinned',
  'landmark',
  'wallet',
  'tags',
  'package',
  'handshake',
  'file-text',
  'hard-drive',
  'clipboard-check',
  'calculator',
  'panels-top-left',
  'list-tree',
  'circle',
  'mail',
  'file-spreadsheet',
  'upload',
  'package-check',
  'hand-helping',
] as const;

/** RESOURCE_ICONS de frontend/src/app/core/layout/sidebar/sidebar.component.ts:35-50 (master c68e560). */
const RESOURCE_ICONS: ReadonlyArray<readonly [string, string]> = [
  ['user', 'users'],
  ['role', 'shield'],
  ['campus', 'map-pinned'],
  ['org_unit', 'landmark'],
  ['cost_center', 'wallet'],
  ['category', 'tags'],
  ['asset', 'package'],
  ['loan', 'handshake'],
  ['document_template', 'file-text'],
  ['storage', 'hard-drive'],
  ['physical_inventory', 'clipboard-check'],
  ['depreciation', 'calculator'],
  ['feature', 'panels-top-left'],
  ['navigation', 'list-tree'],
];

const IMPORTS_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000017401';
const HANDOVERS_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000017402';

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export class NavigationIconsAndNewItems1767225740000 implements MigrationInterface {
  name = 'NavigationIconsAndNewItems1767225740000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE navigation_item ADD COLUMN IF NOT EXISTS icon VARCHAR(40) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE navigation_item DROP CONSTRAINT IF EXISTS ck_navigation_item_icon
    `);
    await queryRunner.query(`
      ALTER TABLE navigation_item ADD CONSTRAINT ck_navigation_item_icon
        CHECK (icon IS NULL OR icon IN (${ICONS.map(quote).join(', ')}))
    `);

    await queryRunner.query(`
      UPDATE navigation_item n
      SET icon = COALESCE(
        (SELECT m.icon
         FROM (VALUES ${RESOURCE_ICONS.map(([resource, icon]) => `(${quote(resource)}, ${quote(icon)})`).join(', ')})
           AS m(resource, icon)
         WHERE m.resource = n.resource),
        'circle'
      )
      WHERE n.icon IS NULL
    `);

    await queryRunner.query(`
      UPDATE navigation_item
      SET path = '/documents', label = 'Documentos', updated_at = NOW()
      WHERE path = '/document-templates'
        AND module = 'ASSET'
        AND module_label = 'Activos'
        AND resource = 'document_template'
        AND label = 'Plantillas'
        AND required_action = 'read'
        AND sort_order = 90
        AND NOT EXISTS (SELECT 1 FROM navigation_item WHERE path = '/documents')
    `);

    await queryRunner.query(`
      INSERT INTO navigation_item
        (id, module, module_label, resource, path, label, required_action, sort_order, icon)
      VALUES
        ('${IMPORTS_ID}', 'ASSET', 'Activos', 'asset', '/imports', 'Importar desde Excel', 'create', 72, 'file-spreadsheet'),
        ('${HANDOVERS_ID}', 'ASSET', 'Activos', 'asset', '/handovers', 'Entregas de activos', 'read', 74, 'package-check')
      ON CONFLICT (path) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM navigation_item WHERE id IN ('${IMPORTS_ID}', '${HANDOVERS_ID}')
    `);
    await queryRunner.query(`
      UPDATE navigation_item
      SET path = '/document-templates', label = 'Plantillas', updated_at = NOW()
      WHERE path = '/documents'
        AND module = 'ASSET'
        AND module_label = 'Activos'
        AND resource = 'document_template'
        AND label = 'Documentos'
        AND required_action = 'read'
        AND sort_order = 90
        AND NOT EXISTS (SELECT 1 FROM navigation_item WHERE path = '/document-templates')
    `);
    await queryRunner.query(`
      ALTER TABLE navigation_item DROP CONSTRAINT IF EXISTS ck_navigation_item_icon
    `);
    await queryRunner.query(`
      ALTER TABLE navigation_item DROP COLUMN IF EXISTS icon
    `);
  }
}
