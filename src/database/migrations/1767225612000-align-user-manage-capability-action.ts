import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AlignUserManageCapabilityAction1767225612000 implements MigrationInterface {
  name = 'AlignUserManageCapabilityAction1767225612000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE permission
      SET action = 'manage'
      WHERE code = 'user:manage:global'
        AND action = 'update'
    `);
    await queryRunner.query(`
      UPDATE permission
      SET action = 'assign'
      WHERE code = 'role:assign:global'
        AND action = 'update'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE permission
      SET action = 'update'
      WHERE code = 'user:manage:global'
        AND action = 'manage'
    `);
    await queryRunner.query(`
      UPDATE permission
      SET action = 'update'
      WHERE code = 'role:assign:global'
        AND action = 'assign'
    `);
  }
}
