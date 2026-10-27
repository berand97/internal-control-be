import type { MigrationInterface, QueryRunner } from 'typeorm';

const FORMAT_KEY = 'OCI-17-90-BAJA';
const CHANGE_REASON = 'Acta de baja según el formato oficial OCI-17-90: firman Control Interno y Contabilidad';

const PENDING_DECISIONS = [
  'Firman Control Interno y luego Contabilidad, pendiente de validar con Control Interno',
  'Un acta puede incluir activos de varios centros de costo, pendiente de validar con Control Interno',
  'Estados del activo en el acta (Obsoleto, Dañado, Robado, No es activo, Otro), pendiente de validar con Control Interno',
  'Total autorizado, acuerdo del Consejo Universitario e informes de Vicefinanciera se escriben en la baja, pendiente de validar con Control Interno',
  'El código OCI-17-90 lo comparten el acta de baja y el informe a Vicefinanciera, pendiente de validar con Control Interno',
];

const SIGNERS = [
  { order: 1, role: 'CONTROL_INTERNO', label: 'Control Interno', source: 'REQUEST' },
  { order: 2, role: 'CONTABILIDAD', label: 'Contabilidad', source: 'REQUEST' },
];

export class WriteOffOfficialAct1767226110000 implements MigrationInterface {
  name = 'WriteOffOfficialAct1767226110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_write_off_item
        ADD COLUMN cost_center_id UUID REFERENCES cost_center(id),
        ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN state VARCHAR(20) NOT NULL DEFAULT 'OBSOLETE',
        ADD COLUMN notes TEXT,
        ADD CONSTRAINT chk_asset_write_off_item_quantity CHECK (quantity BETWEEN 1 AND 10000),
        ADD CONSTRAINT chk_asset_write_off_item_state CHECK (state IN ('OBSOLETE', 'DAMAGED', 'STOLEN', 'NOT_AN_ASSET', 'OTHER'))
    `);
    await queryRunner.query(`
      UPDATE asset_write_off_item i SET cost_center_id = w.cost_center_id
      FROM asset_write_off w WHERE w.id = i.write_off_id
    `);
    await queryRunner.query('ALTER TABLE asset_write_off_item ALTER COLUMN cost_center_id SET NOT NULL');
    await queryRunner.query('ALTER TABLE asset_write_off_item ALTER COLUMN state DROP DEFAULT');
    await queryRunner.query('CREATE INDEX idx_asset_write_off_item_center ON asset_write_off_item (cost_center_id)');

    await queryRunner.query('DROP INDEX idx_asset_write_off_center');
    await queryRunner.query(`
      ALTER TABLE asset_write_off
        DROP CONSTRAINT chk_asset_write_off_reason,
        DROP CONSTRAINT chk_asset_write_off_other_detail,
        DROP CONSTRAINT chk_asset_write_off_concept,
        DROP CONSTRAINT chk_asset_write_off_disposition,
        DROP COLUMN cost_center_id,
        DROP COLUMN responsible_person_id,
        DROP COLUMN reason,
        DROP COLUMN reason_detail,
        DROP COLUMN technical_concept,
        DROP COLUMN final_disposition,
        ADD COLUMN accounting_person_id UUID REFERENCES person(id),
        ADD COLUMN authorized_total NUMERIC(15, 2),
        ADD COLUMN council_agreement_number VARCHAR(100),
        ADD COLUMN council_agreement_date DATE,
        ADD COLUMN vicefinance_reports VARCHAR(200),
        ADD CONSTRAINT chk_asset_write_off_authorized_total CHECK (authorized_total IS NULL OR authorized_total >= 0)
    `);

    const [latest] = (await queryRunner.query(
      'SELECT id FROM document_format_version WHERE format_key = $1 ORDER BY version_number DESC LIMIT 1',
      [FORMAT_KEY],
    )) as Array<{ id: string }>;
    if (!latest) {
      return;
    }
    const [created] = (await queryRunner.query(
      `INSERT INTO document_format_version (format_key, version_number, sgc_code, sgc_version, name, effective_from,
         numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period, pending_decisions, change_reason)
       SELECT format_key, version_number + 1, sgc_code, sgc_version, name,
              GREATEST(coalesce(effective_from, '-infinity'::date), (NOW() AT TIME ZONE 'America/Bogota')::date),
              numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period, $2::jsonb, $3
       FROM document_format_version WHERE id = $1
       RETURNING id`,
      [latest.id, JSON.stringify(PENDING_DECISIONS), CHANGE_REASON],
    )) as Array<{ id: string }>;
    for (const signer of SIGNERS) {
      await queryRunner.query(
        'INSERT INTO document_format_signer (version_id, sign_order, role, label, source) VALUES ($1, $2, $3, $4, $5)',
        [created?.id, signer.order, signer.role, signer.label, signer.source],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT (SELECT count(*)::int FROM asset_write_off) AS write_offs,
              (SELECT count(*)::int FROM document d JOIN document_format_version v ON v.id = d.format_version_id
                 WHERE v.format_key = $1 AND v.change_reason = $2) AS documents`,
      [FORMAT_KEY, CHANGE_REASON],
    )) as Array<{ write_offs: number; documents: number }>;
    if ((row?.write_offs ?? 0) > 0 || (row?.documents ?? 0) > 0) {
      throw new Error(`No se puede revertir sin perder datos: ${row?.write_offs} bajas y ${row?.documents} actas de la versión nueva`);
    }
    await queryRunner.query(
      `DELETE FROM document_format_signer WHERE version_id IN
         (SELECT id FROM document_format_version WHERE format_key = $1 AND change_reason = $2)`,
      [FORMAT_KEY, CHANGE_REASON],
    );
    await queryRunner.query('DELETE FROM document_format_version WHERE format_key = $1 AND change_reason = $2', [FORMAT_KEY, CHANGE_REASON]);
    await queryRunner.query(`
      ALTER TABLE asset_write_off
        DROP CONSTRAINT chk_asset_write_off_authorized_total,
        DROP COLUMN accounting_person_id,
        DROP COLUMN authorized_total,
        DROP COLUMN council_agreement_number,
        DROP COLUMN council_agreement_date,
        DROP COLUMN vicefinance_reports,
        ADD COLUMN cost_center_id UUID NOT NULL REFERENCES cost_center(id),
        ADD COLUMN responsible_person_id UUID NOT NULL REFERENCES person(id),
        ADD COLUMN reason VARCHAR(30) NOT NULL,
        ADD COLUMN reason_detail TEXT,
        ADD COLUMN technical_concept TEXT NOT NULL,
        ADD COLUMN final_disposition TEXT NOT NULL,
        ADD CONSTRAINT chk_asset_write_off_reason
          CHECK (reason IN ('OBSOLESCENCE', 'IRREPARABLE_DAMAGE', 'LOSS', 'THEFT', 'DONATION', 'PERMANENT_TRANSFER', 'OTHER')),
        ADD CONSTRAINT chk_asset_write_off_other_detail
          CHECK (reason <> 'OTHER' OR length(btrim(coalesce(reason_detail, ''))) >= 3),
        ADD CONSTRAINT chk_asset_write_off_concept CHECK (length(btrim(technical_concept)) >= 3),
        ADD CONSTRAINT chk_asset_write_off_disposition CHECK (length(btrim(final_disposition)) >= 3)
    `);
    await queryRunner.query('CREATE INDEX idx_asset_write_off_center ON asset_write_off (cost_center_id)');
    await queryRunner.query('DROP INDEX idx_asset_write_off_item_center');
    await queryRunner.query(`
      ALTER TABLE asset_write_off_item
        DROP CONSTRAINT chk_asset_write_off_item_quantity,
        DROP CONSTRAINT chk_asset_write_off_item_state,
        DROP COLUMN cost_center_id,
        DROP COLUMN quantity,
        DROP COLUMN state,
        DROP COLUMN notes
    `);
  }
}
