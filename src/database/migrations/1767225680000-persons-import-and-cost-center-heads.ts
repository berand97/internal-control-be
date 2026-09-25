import type { MigrationInterface, QueryRunner } from 'typeorm';

// Copia fija del catálogo (src/common/identity/identity-document-types.ts) al momento de esta migración.
const DOCUMENT_TYPES = ['CC', 'CE', 'PA', 'PEP', 'PPT', 'TI'];
const PERSON_FLAGS = ['DOCUMENT_TYPE_UNKNOWN', 'NAME_NOT_SPLIT'];
const PREVIOUS_TARGETS = ['ASSETS', 'COST_CENTERS'];

const list = (values: ReadonlyArray<string>): string => values.map((value) => `'${value}'`).join(', ');

/**
 * - Destino PERSONS en la importación de Excel y el origen de cada persona importada.
 * - person.data_quality_flags (como asset) y el catálogo de tipos de documento.
 * - Protección de números de documento sin tipo: con document_type NULL la unicidad (tipo, número) no aplica
 *   (NULL no es igual a NULL), así que un índice único parcial impide dos personas sin tipo con el mismo número.
 * - cost_center_head: quién dirige cada centro de costo (HU 1.0.14), a nivel de persona y con vigencia.
 */
export class PersonsImportAndCostCenterHeads1767225680000 implements MigrationInterface {
  name = 'PersonsImportAndCostCenterHeads1767225680000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE staging_import DROP CONSTRAINT chk_staging_import_target');
    await queryRunner.query(`
      ALTER TABLE staging_import ADD CONSTRAINT chk_staging_import_target
        CHECK (target IN (${list([...PREVIOUS_TARGETS, 'PERSONS'])}))
    `);

    await queryRunner.query(`
      ALTER TABLE person
        ADD COLUMN data_quality_flags VARCHAR(40)[] NOT NULL DEFAULT '{}',
        ADD CONSTRAINT chk_person_data_quality_flags
          CHECK (data_quality_flags <@ ARRAY[${list(PERSON_FLAGS)}]::VARCHAR(40)[])
    `);

    // Tipos fuera del catálogo que ya existan no se tocan: la restricción queda NOT VALID (aplica a lo nuevo) y
    // la migración lo dice. En staging (restauración de producción) no hay ninguno.
    const [invalid] = (await queryRunner.query(
      `SELECT count(*)::int AS total FROM person WHERE document_type IS NOT NULL AND document_type NOT IN (${list(DOCUMENT_TYPES)})`,
    )) as Array<{ total: number }>;
    await queryRunner.query(`
      ALTER TABLE person ADD CONSTRAINT chk_person_document_type
        CHECK (document_type IS NULL OR document_type IN (${list(DOCUMENT_TYPES)}))${(invalid?.total ?? 0) > 0 ? ' NOT VALID' : ''}
    `);

    const [untypedDuplicates] = (await queryRunner.query(`
      SELECT count(*)::int AS total FROM (
        SELECT document_number FROM person
        WHERE document_type IS NULL AND document_number IS NOT NULL
        GROUP BY document_number HAVING count(*) > 1) d
    `)) as Array<{ total: number }>;
    if ((untypedDuplicates?.total ?? 0) > 0) {
      throw new Error(
        `Hay ${untypedDuplicates?.total} números de documento repetidos entre personas sin tipo de documento; corríjalos antes de migrar`,
      );
    }
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_person_document_number_untyped ON person (document_number)
        WHERE document_type IS NULL AND document_number IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE person_import_origin (
        person_id             UUID PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
        import_id             UUID REFERENCES staging_import(id) ON DELETE SET NULL,
        source_file           VARCHAR(255) NOT NULL,
        sheet_name            VARCHAR(100) NOT NULL,
        row_number            INTEGER NOT NULL,
        document_type_source  VARCHAR(30) NOT NULL,
        imported_by           UUID REFERENCES app_user(id),
        imported_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_person_import_origin_type_source
          CHECK (document_type_source IN ('COLUMN', 'DECLARED_BY_OPERATOR', 'UNKNOWN'))
      )
    `);
    await queryRunner.query('CREATE INDEX idx_person_import_origin_import ON person_import_origin (import_id)');

    await queryRunner.query(`
      CREATE TABLE cost_center_head (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id       UUID NOT NULL REFERENCES person(id),
        cost_center_id  UUID NOT NULL REFERENCES cost_center(id),
        valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_until     TIMESTAMPTZ,
        reason          TEXT NOT NULL,
        assigned_by     UUID REFERENCES app_user(id),
        assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_by        UUID REFERENCES app_user(id),
        ended_at        TIMESTAMPTZ,
        end_reason      TEXT,
        CONSTRAINT chk_cost_center_head_range CHECK (valid_until IS NULL OR valid_until >= valid_from),
        CONSTRAINT chk_cost_center_head_end CHECK (
          (ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL)
          OR (ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_until IS NOT NULL))
      )
    `);
    await queryRunner.query('CREATE INDEX idx_cost_center_head_person ON cost_center_head (person_id, valid_from)');
    await queryRunner.query('CREATE INDEX idx_cost_center_head_center ON cost_center_head (cost_center_id, valid_from)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM staging_import WHERE target = 'PERSONS')::int AS imports,
        (SELECT count(*) FROM person_import_origin)::int AS imported,
        (SELECT count(*) FROM cost_center_head)::int AS heads,
        (SELECT count(*) FROM person WHERE cardinality(data_quality_flags) > 0)::int AS flagged
    `)) as Array<{ imports: number; imported: number; heads: number; flagged: number }>;
    if (row && (row.imports > 0 || row.imported > 0 || row.heads > 0 || row.flagged > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.imports} importaciones de personas, ${row.imported} personas importadas, ` +
          `${row.heads} jefaturas de centro de costo, ${row.flagged} personas con marcas de calidad`,
      );
    }
    await queryRunner.query('DROP TABLE cost_center_head');
    await queryRunner.query('DROP TABLE person_import_origin');
    await queryRunner.query('DROP INDEX uq_person_document_number_untyped');
    await queryRunner.query('ALTER TABLE person DROP CONSTRAINT chk_person_document_type');
    await queryRunner.query('ALTER TABLE person DROP CONSTRAINT chk_person_data_quality_flags');
    await queryRunner.query('ALTER TABLE person DROP COLUMN data_quality_flags');
    await queryRunner.query('ALTER TABLE staging_import DROP CONSTRAINT chk_staging_import_target');
    await queryRunner.query(`
      ALTER TABLE staging_import ADD CONSTRAINT chk_staging_import_target
        CHECK (target IN (${list(PREVIOUS_TARGETS)}))
    `);
  }
}
