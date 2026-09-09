import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RevokeDirectorStorage1767225623000 implements MigrationInterface {
  name = 'RevokeDirectorStorage1767225623000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission rp
      USING role r, permission p
      WHERE rp.role_id = r.id
        AND rp.permission_id = p.id
        AND r.code = 'INTERNAL_CONTROL_DIRECTOR'
        AND p.code = 'storage:manage:global'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = 'storage:manage:global'
      WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR'
      ON CONFLICT DO NOTHING
    `);
  }
}
