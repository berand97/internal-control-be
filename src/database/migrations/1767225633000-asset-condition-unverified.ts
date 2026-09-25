import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetConditionUnverified1767225633000 implements MigrationInterface {
  name = 'AssetConditionUnverified1767225633000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE asset ALTER COLUMN physical_condition DROP NOT NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      'SELECT count(*)::int AS unverified FROM asset WHERE physical_condition IS NULL',
    )) as Array<{ unverified: number }>;
    if ((row?.unverified ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin inventar un estado: ${row?.unverified} activos sin estado físico verificado`,
      );
    }
    await queryRunner.query('ALTER TABLE asset ALTER COLUMN physical_condition SET NOT NULL');
  }
}
