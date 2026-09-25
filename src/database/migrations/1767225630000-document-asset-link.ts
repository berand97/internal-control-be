import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentAssetLink1767225630000 implements MigrationInterface {
  name = 'DocumentAssetLink1767225630000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_asset (
        document_id  UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
        asset_id     UUID NOT NULL REFERENCES asset(id),
        movement_id  UUID REFERENCES asset_movement(id),
        PRIMARY KEY (document_id, asset_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_document_asset_asset ON document_asset (asset_id)');
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_document_asset_movement ON document_asset (movement_id) WHERE movement_id IS NOT NULL',
    );
    await queryRunner.query(`
      INSERT INTO document_asset (document_id, asset_id)
      SELECT DISTINCT d.id, (item->>'id')::uuid
      FROM document d
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.data->'activos', '[]'::jsonb)) AS item
      JOIN asset a ON a.id = (item->>'id')::uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      'SELECT count(*)::int AS linked FROM document_asset WHERE movement_id IS NOT NULL',
    )) as Array<{ linked: number }>;
    if ((row?.linked ?? 0) > 0) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row?.linked} documentos enlazados a su movimiento`,
      );
    }
    await queryRunner.query('DROP TABLE document_asset');
  }
}
