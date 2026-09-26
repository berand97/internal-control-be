import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Formatos SGC administrables y versionados (antes vivían en src/modules/documents/domain/document-formats.ts):
 *
 * - document_format: la identidad estable del formato (clave interna, permisos de lectura y generación). La clave
 *   es la que usan los procesos enchufados en código (OCI-01-55 → entregas, OCI-01-65 → préstamos, LOAN_RETURN →
 *   devolución) y el consecutivo (document_sequence.format_key): no cambia nunca.
 * - document_format_version: lo administrable (código y versión SGC, nombre, forma y valor inicial del consecutivo,
 *   decisiones pendientes) con su fecha de vigencia. Nunca se sobrescribe (trigger): cada cambio es una versión
 *   nueva. effective_from NULL solo en la versión 1 sembrada aquí: vigente desde siempre (el catálogo en código no
 *   tenía fecha).
 * - document_format_signer: firmantes de cada versión (orden, rol, etiqueta, origen RESPONSIBLE/REQUEST).
 * - document.format_version_id: la versión con la que se emitió cada acta. Las existentes quedan enlazadas a la
 *   versión 1 de su formato (la única que existía). Firmantes, etiquetas y verificación salen de aquí.
 *
 * La semilla copia literalmente el catálogo de document-formats.ts en el commit anterior (mismos códigos, versiones,
 * firmantes, numeración, lastIssued y pendingDecisions). document_sequence no se toca.
 */

interface SeedSigner {
  readonly order: number;
  readonly role: string;
  readonly label: string;
  readonly source: 'RESPONSIBLE' | 'REQUEST';
}

interface SeedFormat {
  readonly key: string;
  readonly sgcCode: string | null;
  readonly version: string | null;
  readonly name: string;
  readonly width: number;
  readonly perYear: boolean;
  readonly lastIssued: number;
  readonly lastIssuedPeriod: string | null;
  readonly readPermission: string;
  readonly generatePermission: string;
  readonly signers: ReadonlyArray<SeedSigner>;
  readonly pendingDecisions: ReadonlyArray<string>;
}

const AUDITA = (order: number): SeedSigner => ({
  order,
  role: 'AUDITA',
  label: 'Control Interno',
  source: 'REQUEST',
});

const SEED: ReadonlyArray<SeedFormat> = [
  {
    key: 'OCI-01-55',
    sgcCode: 'OCI-01-55',
    version: '2',
    name: 'Acta de entrega y asignación de activos fijos',
    width: 4,
    perYear: false,
    lastIssued: 92,
    lastIssuedPeriod: null,
    readPermission: 'asset:read:global',
    generatePermission: 'asset:update:global',
    signers: [
      { order: 1, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      AUDITA(2),
    ],
    pendingDecisions: [],
  },
  {
    key: 'OCI-01-65',
    sgcCode: 'OCI-01-65',
    version: '2',
    name: 'Acta de préstamo temporal de activos fijos',
    width: 4,
    perYear: true,
    lastIssued: 1,
    lastIssuedPeriod: '2026',
    readPermission: 'loan:read:global',
    generatePermission: 'loan:update:global',
    signers: [
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      AUDITA(3),
    ],
    pendingDecisions: [],
  },
  {
    key: 'OCI-17-89',
    sgcCode: 'OCI-17-89',
    version: '1',
    name: 'Acta de traslado de activos fijos',
    width: 5,
    perYear: false,
    lastIssued: 143,
    lastIssuedPeriod: null,
    readPermission: 'asset:read:global',
    generatePermission: 'asset:update:global',
    signers: [
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      {
        order: 3,
        role: 'CONTROL_INTERNO',
        label: 'Control Interno',
        source: 'REQUEST',
      },
      {
        order: 4,
        role: 'CONTABILIDAD',
        label: 'Contabilidad',
        source: 'REQUEST',
      },
    ],
    pendingDecisions: [],
  },
  {
    key: 'OCI-17-90-BAJA',
    sgcCode: 'OCI-17-90',
    version: '1',
    name: 'Acta de baja de activos fijos',
    width: 5,
    perYear: false,
    lastIssued: 19,
    lastIssuedPeriod: null,
    readPermission: 'asset:read:global',
    generatePermission: 'asset:write_off:global',
    signers: [
      {
        order: 1,
        role: 'RESPONSABLE',
        label: 'Responsable',
        source: 'RESPONSIBLE',
      },
      AUDITA(2),
    ],
    pendingDecisions: [
      'Comparte el código OCI-17-90 con el informe a Vicefinanciera: Control Interno debe resolver la duplicación',
      'Firmantes y orden por confirmar con Control Interno',
    ],
  },
  {
    key: 'OCI-17-90-INFORME',
    sgcCode: 'OCI-17-90',
    version: '1',
    name: 'Informe de baja a la Vicerrectoría Financiera',
    width: 5,
    perYear: false,
    lastIssued: 17,
    lastIssuedPeriod: null,
    readPermission: 'asset:read:global',
    generatePermission: 'asset:write_off:global',
    signers: [AUDITA(1)],
    pendingDecisions: [
      'Comparte el código OCI-17-90 con el acta de baja: Control Interno debe resolver la duplicación',
      'Firmantes y orden por confirmar con Control Interno',
    ],
  },
  {
    key: 'OCI-21-37',
    sgcCode: 'OCI-21-37',
    version: '2',
    name: 'Acta de toma física de inventario de activos fijos',
    width: 5,
    perYear: false,
    lastIssued: 5,
    lastIssuedPeriod: null,
    readPermission: 'inventory:read:global',
    generatePermission: 'inventory:execute:global',
    signers: [
      {
        order: 1,
        role: 'RESPONSABLE',
        label: 'Responsable',
        source: 'RESPONSIBLE',
      },
      AUDITA(2),
    ],
    pendingDecisions: ['Firmantes y orden por confirmar con Control Interno'],
  },
  {
    key: 'LOAN_RETURN',
    sgcCode: null,
    version: null,
    name: 'Acta de devolución de préstamo temporal de activos fijos',
    width: 4,
    perYear: true,
    lastIssued: 0,
    lastIssuedPeriod: null,
    readPermission: 'loan:read:global',
    generatePermission: 'loan:update:global',
    signers: [],
    pendingDecisions: [
      'Código SGC y versión: formato nuevo que la universidad aún no ha emitido',
      'Firmantes y orden del acta de devolución: no definidos por Control Interno',
      'Formato del consecutivo (dígitos, anual o continuo): se usa AAAA-NNNN provisional, igual que OCI-01-65',
    ],
  },
];

export class AdministrableDocumentFormats1767225730000 implements MigrationInterface {
  name = 'AdministrableDocumentFormats1767225730000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_format (
        key                  VARCHAR(40) PRIMARY KEY,
        read_permission      VARCHAR(100) NOT NULL,
        generate_permission  VARCHAR(100) NOT NULL,
        created_by           UUID REFERENCES app_user(id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_document_format_key CHECK (key ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$')
      )
    `);
    await queryRunner.query(`
      CREATE TABLE document_format_version (
        id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        format_key                    VARCHAR(40) NOT NULL REFERENCES document_format(key),
        version_number                INTEGER NOT NULL,
        sgc_code                      VARCHAR(20),
        sgc_version                   VARCHAR(10),
        name                          VARCHAR(200) NOT NULL,
        effective_from                DATE,
        numbering_width               SMALLINT NOT NULL,
        numbering_per_year            BOOLEAN NOT NULL,
        numbering_last_issued         BIGINT NOT NULL,
        numbering_last_issued_period  VARCHAR(10),
        pending_decisions             JSONB NOT NULL DEFAULT '[]'::jsonb,
        change_reason                 VARCHAR(500),
        created_by                    UUID REFERENCES app_user(id),
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_document_format_version UNIQUE (format_key, version_number),
        CONSTRAINT chk_document_format_version_number CHECK (version_number >= 1),
        CONSTRAINT chk_document_format_version_effective CHECK (effective_from IS NOT NULL OR version_number = 1),
        CONSTRAINT chk_document_format_version_width CHECK (numbering_width BETWEEN 1 AND 10),
        CONSTRAINT chk_document_format_version_last_issued CHECK (numbering_last_issued >= 0),
        CONSTRAINT chk_document_format_version_period CHECK (numbering_per_year OR numbering_last_issued_period IS NULL),
        CONSTRAINT chk_document_format_version_decisions CHECK (jsonb_typeof(pending_decisions) = 'array')
      )
    `);
    await queryRunner.query(`
      CREATE TABLE document_format_signer (
        version_id  UUID NOT NULL REFERENCES document_format_version(id) ON DELETE CASCADE,
        sign_order  SMALLINT NOT NULL,
        role        VARCHAR(40) NOT NULL,
        label       VARCHAR(80) NOT NULL,
        source      VARCHAR(20) NOT NULL,
        PRIMARY KEY (version_id, sign_order),
        CONSTRAINT uq_document_format_signer_role UNIQUE (version_id, role),
        CONSTRAINT chk_document_format_signer_order CHECK (sign_order >= 1),
        CONSTRAINT chk_document_format_signer_role CHECK (role ~ '^[A-Z][A-Z0-9_]{0,39}$'),
        CONSTRAINT chk_document_format_signer_source CHECK (source IN ('RESPONSIBLE', 'REQUEST'))
      )
    `);
    // Una versión emitida no se reescribe: editar es crear otra (las actas describen las reglas con que se emitieron).
    await queryRunner.query(`
      CREATE FUNCTION fn_prevent_document_format_version_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Una versión de formato no se modifica: cree una versión nueva';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_document_format_version_no_update BEFORE UPDATE ON document_format_version
        FOR EACH ROW EXECUTE FUNCTION fn_prevent_document_format_version_update()
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_document_format_signer_no_update BEFORE UPDATE ON document_format_signer
        FOR EACH ROW EXECUTE FUNCTION fn_prevent_document_format_version_update()
    `);

    for (const format of SEED) {
      await queryRunner.query(
        'INSERT INTO document_format (key, read_permission, generate_permission) VALUES ($1, $2, $3)',
        [format.key, format.readPermission, format.generatePermission],
      );
      const [version] = (await queryRunner.query(
        `INSERT INTO document_format_version (format_key, version_number, sgc_code, sgc_version, name, effective_from,
           numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period, pending_decisions,
           change_reason)
         VALUES ($1, 1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, 'Versión inicial: catálogo que estaba en el código')
         RETURNING id`,
        [
          format.key,
          format.sgcCode,
          format.version,
          format.name,
          format.width,
          format.perYear,
          format.lastIssued,
          format.lastIssuedPeriod,
          JSON.stringify(format.pendingDecisions),
        ],
      )) as Array<{ id: string }>;
      for (const signer of format.signers) {
        await queryRunner.query(
          'INSERT INTO document_format_signer (version_id, sign_order, role, label, source) VALUES ($1, $2, $3, $4, $5)',
          [version?.id, signer.order, signer.role, signer.label, signer.source],
        );
      }
    }

    await queryRunner.query(
      'ALTER TABLE document ADD COLUMN format_version_id UUID REFERENCES document_format_version(id)',
    );
    await queryRunner.query(`
      UPDATE document d SET format_version_id = v.id
      FROM document_format_version v
      WHERE v.format_key = d.format_key AND v.version_number = 1
    `);
    const orphans = (await queryRunner.query(
      'SELECT format_key, count(*)::int AS total FROM document WHERE format_version_id IS NULL GROUP BY format_key',
    )) as Array<{ format_key: string; total: number }>;
    if (orphans.length > 0) {
      throw new Error(
        `Hay actas de formatos que no estaban en el catálogo: ${orphans.map((row) => `${row.format_key} (${row.total})`).join(', ')}`,
      );
    }
    await queryRunner.query(
      'ALTER TABLE document ALTER COLUMN format_version_id SET NOT NULL',
    );
    await queryRunner.query(
      'CREATE INDEX idx_document_format_version ON document (format_version_id)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `
      SELECT
        (SELECT count(*) FROM document_format_version WHERE version_number > 1)::int AS versions,
        (SELECT count(*) FROM document_format WHERE key <> ALL($1::text[]))::int AS formats
    `,
      [SEED.map((format) => format.key)],
    )) as Array<{ versions: number; formats: number }>;
    if (row && (row.versions > 0 || row.formats > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.versions} versiones de formato creadas por administración y ` +
          `${row.formats} formatos nuevos (el catálogo en código solo conoce la versión inicial)`,
      );
    }
    await queryRunner.query('DROP INDEX idx_document_format_version');
    await queryRunner.query(
      'ALTER TABLE document DROP COLUMN format_version_id',
    );
    await queryRunner.query('DROP TABLE document_format_signer');
    await queryRunner.query('DROP TABLE document_format_version');
    await queryRunner.query('DROP TABLE document_format');
    await queryRunner.query(
      'DROP FUNCTION fn_prevent_document_format_version_update()',
    );
  }
}
