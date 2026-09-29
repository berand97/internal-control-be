import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Categorías de hallazgo sin «pendiente de definir».
 *
 * pending_definition sale del catálogo: ANI se eliminó (1767225990000) y ninguna categoría queda sin definición. Se
 * borra la columna para que no quede un dato sin efecto. Si alguna fila estuviera en TRUE (creada o editada desde el
 * catálogo después de 1767225990000), primero se desactiva: antes no se sugería ni se asignaba, y así sigue igual.
 * down() vuelve a crear la columna en FALSE (valor de todas las filas después de 1767225990000); no puede saber cuáles
 * se desactivaron por estar pendientes, esas quedan inactivas.
 */
export class CustodianRetirementLoanCancelAndSurplusCenter1767226010000 implements MigrationInterface {
  name = 'CustodianRetirementLoanCancelAndSurplusCenter1767226010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'UPDATE inventory_finding_category SET is_active = FALSE, updated_at = NOW() WHERE pending_definition AND is_active',
    );
    await queryRunner.query('ALTER TABLE inventory_finding_category DROP COLUMN pending_definition');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE inventory_finding_category ADD COLUMN pending_definition BOOLEAN NOT NULL DEFAULT FALSE',
    );
  }
}
