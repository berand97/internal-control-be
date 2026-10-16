import type { MigrationInterface, QueryRunner } from 'typeorm';

const UP_REASON = 'Tipos de la Estructura Orgánica (Acuerdo 008/2021, numeral 1.5)';
const DOWN_REASON = 'Reversión de los tipos de la Estructura Orgánica';

const NORMALIZED_NAME = `translate(lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')), 'áéíóúüñ', 'aeiouun')`;

export class OrgUnitTypesEstructuraOrganica1767226080000 implements MigrationInterface {
  name = 'OrgUnitTypesEstructuraOrganica1767226080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.retype(
      queryRunner,
      `CASE
         WHEN unit_type IN ('AREA', 'OTHER') THEN 'DEPENDENCY'
         WHEN unit_type = 'COUNCIL' AND ${NORMALIZED_NAME} LIKE 'comite%' THEN 'COMMITTEE'
         WHEN unit_type = 'COUNCIL' AND ${NORMALIZED_NAME} LIKE 'comision%' THEN 'COMMISSION'
       END`,
      UP_REASON,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.retype(
      queryRunner,
      `CASE
         WHEN unit_type = 'DEPENDENCY' THEN 'OTHER'
         WHEN unit_type IN ('COMMITTEE', 'COMMISSION') THEN 'COUNCIL'
       END`,
      DOWN_REASON,
    );
  }

  private async retype(queryRunner: QueryRunner, nextType: string, reason: string): Promise<void> {
    await queryRunner.query(
      `WITH changed AS (
         SELECT id, unit_type AS old_type, ${nextType} AS new_type FROM organizational_unit
       ),
       updated AS (
         UPDATE organizational_unit u SET unit_type = c.new_type, updated_at = NOW()
         FROM changed c
         WHERE u.id = c.id AND c.new_type IS NOT NULL AND c.new_type <> c.old_type
         RETURNING u.id, c.old_type, c.new_type
       )
       INSERT INTO org_structure_history (entity_type, entity_id, field, old_value, new_value, source, reason)
       SELECT 'ORG_UNIT', id, 'TYPE', old_type, new_type, 'AUTO', $1 FROM updated`,
      [reason],
    );
  }
}
