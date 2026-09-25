// Importación de personas por la importación de Excel existente (destino PERSONS): upload → mapeo → vista previa
// → confirmar, idempotente, identidad por (tipo, número), cuarentena con motivo, y sin copiar el número de
// documento a la cuarentena, los problemas ni audit_log.
import type { TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { PersonsModule } from '../../src/modules/persons/persons.module.js';
import { PersonDirectoryService } from '../../src/modules/persons/services/person-directory.service.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import { bootModules, createActor, scalar } from './helpers.js';

type Cell = string | number | null;

const workbook = async (sheet: string, rows: ReadonlyArray<ReadonlyArray<Cell>>): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet(sheet);
  rows.forEach((values, index) => {
    const row = ws.getRow(index + 1);
    values.forEach((value, column) => {
      if (value !== null) {
        row.getCell(column + 1).value = value;
      }
    });
    row.commit();
  });
  return Buffer.from(await book.xlsx.writeBuffer());
};

// Mismas columnas que la hoja revision_datos_migrados de «contratos activos»: sin tipo de documento ni correo.
const CONTRACT_HEADER = [
  'Número de documento de identificación',
  'Nombres y Apellidos del empleado',
  'Grupo de compensación',
  'Cargo',
  'Líder de equipo',
  'Área',
  'División',
  'Código del centro de costo',
  'Centro de costo',
];
const CONTRACT_MAPPING = { documentNumber: 'A', fullName: 'B', positionTitle: 'D', costCenterCode: 'H' };

describe('Importación de personas (destino PERSONS, PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let imports: ExcelImportService;
  let actor: AuthenticatedUser;
  let center: string;
  const tag = () => randomUUID().replace(/\D/g, '').padEnd(8, '7').slice(0, 8);

  beforeAll(async () => {
    moduleRef = await bootModules(StagingModule, PersonsModule);
    dataSource = moduleRef.get(DataSource);
    imports = moduleRef.get(ExcelImportService);
    actor = await createActor(dataSource);
    center = `PI${tag().slice(0, 6)}`;
    await dataSource.query(`INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro de personas')`, [center]);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const count = (sql: string, params: unknown[] = []) => scalar<string>(dataSource, sql, params).then(Number);

  /** El número no puede aparecer en cuarentena, problemas ni audit_log de la importación. */
  const expectNoDocumentNumbers = async (importId: string, numbers: ReadonlyArray<string>) => {
    const texts = (await dataSource.query(
      `SELECT to_jsonb(q)::text AS t FROM staging_quarantine q WHERE import_id = $1
       UNION ALL SELECT to_jsonb(i)::text FROM staging_issue i WHERE import_id = $1
       UNION ALL SELECT to_jsonb(a)::text FROM audit_log a WHERE entity_id = $1
       UNION ALL SELECT coalesce(preview::text, '') || coalesce(result::text, '') || options::text FROM staging_import WHERE id = $1`,
      [importId],
    )) as Array<{ t: string }>;
    const all = texts.map((row) => row.t).join('\n');
    for (const number of numbers) {
      expect(all).not.toContain(number);
    }
  };

  it('el archivo de contratos (sin correo ni tipo) no entra nadie: todo a cuarentena con motivo, sin escribir en la vista previa', async () => {
    const base = tag();
    const numbers = [`10${base}`, `11${base}`, `12${base}`];
    const file = await workbook('revision_datos_migrados', [
      CONTRACT_HEADER,
      [numbers[0] ?? '', 'CRISTIAN CAMILO GOMEZ TUBERQUIA', 'UNAC EMPLEADOS', 'DESARROLLADOR', null, 'ÁREA', 'DIV', center, 'Centro'],
      [numbers[1] ?? '', 'ANA MARIA LOPEZ', 'UNAC EMPLEADOS', 'ANALISTA', 'LIDER', 'ÁREA', 'DIV', 'NO-EXISTE-1', 'X'],
      [numbers[2] ?? '', 'JUAN PEREZ', 'UNAC EMPLEADOS', 'AUXILIAR', null, 'ÁREA', 'DIV', center, 'Centro'],
    ]);
    const upload = await imports.upload(file, 'contratos.xlsx', actor.id);
    expect(upload.sheets[0]).toMatchObject({ detectedHeaderRow: 1, columns: { A: CONTRACT_HEADER[0], B: CONTRACT_HEADER[1] } });
    const before = await count('SELECT count(*) FROM person');
    const preview = await imports.preview(
      upload.batchId,
      { sheet: 'revision_datos_migrados', target: 'PERSONS', mapping: CONTRACT_MAPPING },
      actor.id,
    );
    expect(await count('SELECT count(*) FROM person')).toBe(before);
    expect(preview.summary).toMatchObject({
      rowsRead: 3,
      toInsert: 0,
      alreadyPresent: 0,
      quarantined: { EMAIL_MISSING: 2, COST_CENTER_UNKNOWN: 1 },
    });
    const metric = (key: string) => preview.summary.metrics.find((item) => item.key === key);
    expect(metric('PERSONS_WITHOUT_EMAIL')?.value).toBe(3);
    expect(metric('PERSONS_WITHOUT_DOCUMENT_TYPE')?.value).toBe(3);
    expect(metric('PERSONS_COST_CENTER_UNKNOWN_ROWS')?.value).toBe(1);
    expect(metric('PERSONS_COST_CENTER_UNKNOWN')).toMatchObject({ value: 1, detail: 'NO-EXISTE-1' });

    const result = await imports.confirm(preview.importId, actor.id);
    expect(result).toMatchObject({ inserted: 0, skippedAlreadyPresent: 0, registrationMovements: 0 });
    expect(await count('SELECT count(*) FROM person')).toBe(before);
    const quarantine = (await imports.quarantine(preview.importId)) as Array<Record<string, unknown>>;
    expect(quarantine).toEqual([
      expect.objectContaining({ rowNumber: 2, reason: 'EMAIL_MISSING', legacyAssetId: null }),
      expect.objectContaining({ rowNumber: 3, reason: 'COST_CENTER_UNKNOWN', detail: 'Centro de costo NO-EXISTE-1' }),
      expect.objectContaining({ rowNumber: 4, reason: 'EMAIL_MISSING', legacyAssetId: null }),
    ]);
    await expectNoDocumentNumbers(preview.importId, numbers);
  });

  it('sin tipo ni declaración: guarda tipo NULL con DOCUMENT_TYPE_UNKNOWN y el nombre sin partir; reimportar no duplica', async () => {
    const base = tag();
    const numbers = [`20${base}`, `21${base}`];
    const rows: Cell[][] = [
      ['Documento', 'Nombre', 'Cargo', 'Centro', 'Correo'],
      [numbers[0] ?? '', 'CRISTIAN CAMILO GOMEZ TUBERQUIA', 'DESARROLLADOR', center, `cristian.${base}@unac.edu.co`],
      [numbers[1] ?? '', 'LUISA FERNANDA RIOS', 'ANALISTA', null, `luisa.${base}@unac.edu.co`],
    ];
    const file = await workbook('Personas', rows);
    const mapping = { documentNumber: 'A', fullName: 'B', positionTitle: 'C', costCenterCode: 'D', email: 'E' };
    const upload = await imports.upload(file, 'personas.xlsx', actor.id);
    const preview = await imports.preview(upload.batchId, { sheet: 'Personas', target: 'PERSONS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({
      rowsRead: 2,
      toInsert: 2,
      quarantined: {},
      flagged: { DOCUMENT_TYPE_UNKNOWN: 2, NAME_NOT_SPLIT: 2 },
    });
    expect(await imports.confirm(preview.importId, actor.id)).toMatchObject({ inserted: 2, skippedAlreadyPresent: 0 });

    const [stored] = (await dataSource.query(
      `SELECT p.document_type, p.first_name, p.last_name, p.position_title, p.data_quality_flags, p.cost_center_id,
              cc.external_code, o.document_type_source, o.row_number, o.import_id
       FROM person p JOIN person_import_origin o ON o.person_id = p.id LEFT JOIN cost_center cc ON cc.id = p.cost_center_id
       WHERE p.document_number = $1`,
      [numbers[0]],
    )) as Array<Record<string, unknown>>;
    expect(stored).toMatchObject({
      document_type: null,
      first_name: 'CRISTIAN CAMILO GOMEZ TUBERQUIA',
      last_name: '',
      position_title: 'DESARROLLADOR',
      data_quality_flags: ['DOCUMENT_TYPE_UNKNOWN', 'NAME_NOT_SPLIT'],
      external_code: center,
      document_type_source: 'UNKNOWN',
      row_number: 2,
      import_id: preview.importId,
    });
    const job = (await dataSource.query('SELECT options FROM staging_import WHERE id = $1', [preview.importId])) as Array<{
      options: Record<string, unknown>;
    }>;
    expect(job[0]?.options).toEqual({ documentTypeSource: 'UNKNOWN' });

    // El nombre sin partir se muestra completo, sin espacios sobrantes, donde se concatenan nombres y apellidos.
    const directory = moduleRef.get(PersonDirectoryService, { strict: false });
    const found = await directory.search({ search: 'GOMEZ TUBERQUIA', page: 1, pageSize: 5 });
    expect(found.items.find((item) => item.documentNumber === numbers[0])).toMatchObject({
      name: 'CRISTIAN CAMILO GOMEZ TUBERQUIA',
      documentType: null,
    });

    const again = await imports.preview(upload.batchId, { sheet: 'Personas', target: 'PERSONS', mapping }, actor.id);
    expect(again.summary).toMatchObject({ toInsert: 0, alreadyPresent: 2 });
    expect(await imports.confirm(again.importId, actor.id)).toMatchObject({ inserted: 0, skippedAlreadyPresent: 2 });
    expect(await count('SELECT count(*) FROM person WHERE document_number = ANY($1)', [numbers])).toBe(2);

    // Protección de números sin tipo: la base rechaza otra persona sin tipo con el mismo número.
    await expect(
      dataSource.query(
        `INSERT INTO person (first_name, last_name, email, document_number) VALUES ('Otra', 'Persona', 'otra@unac.edu.co', $1)`,
        [numbers[0]],
      ),
    ).rejects.toThrow(/uq_person_document_number_untyped/);

    // Mismo número con tipo declarado: la persona ya existe sin tipo → conflicto a cuarentena, sin duplicar.
    const declared = await imports.preview(
      upload.batchId,
      { sheet: 'Personas', target: 'PERSONS', mapping, documentType: 'CC' },
      actor.id,
    );
    expect(declared.summary).toMatchObject({ toInsert: 0, quarantined: { DOCUMENT_TYPE_CONFLICT: 2 } });
    await expectNoDocumentNumbers(declared.importId, numbers);
    await expectNoDocumentNumbers(preview.importId, numbers);
  });

  it('el operador declara el tipo del lote: queda registrado como DECLARED_BY_OPERATOR y valida CC numérica', async () => {
    const base = tag();
    const rows: Cell[][] = [
      ['Documento', 'Nombres', 'Apellidos', 'Correo'],
      [`30${base}`, 'MARTA', 'SUAREZ', `marta.${base}@unac.edu.co`],
      [`AB-${base}`, 'PEDRO', 'GIL', `pedro.${base}@unac.edu.co`],
      [`31${base}`, 'SOFIA', 'VEGA', `sofia.${base}@gmail.com`],
      [`32${base}`, 'LAURA', 'MEJIA', `laura.${base}@unac.edu.co`],
      [`32${base}`, 'LAURA', 'MEJIA', `laura2.${base}@unac.edu.co`],
      [null, 'SIN', 'DOCUMENTO', `sin.${base}@unac.edu.co`],
      [`33${base}`, 'SIN APELLIDO', null, `sa.${base}@unac.edu.co`],
    ];
    const upload = await imports.upload(await workbook('Hoja', rows), 'declarado.xlsx', actor.id);
    const mapping = { documentNumber: 'A', firstName: 'B', lastName: 'C', email: 'D' };
    const preview = await imports.preview(upload.batchId, { sheet: 'Hoja', target: 'PERSONS', mapping, documentType: 'CC' }, actor.id);
    expect(preview.summary).toMatchObject({
      rowsRead: 7,
      toInsert: 1,
      quarantined: {
        DOCUMENT_NUMBER_INVALID: 1,
        EMAIL_NOT_INSTITUTIONAL: 1,
        DOCUMENT_NUMBER_DUPLICATED: 2,
        DOCUMENT_NUMBER_MISSING: 1,
        REQUIRED_FIELD_MISSING: 1,
      },
      flagged: {},
    });
    expect(await imports.confirm(preview.importId, actor.id)).toMatchObject({ inserted: 1 });
    const [stored] = (await dataSource.query(
      `SELECT p.document_type, p.first_name, p.last_name, p.data_quality_flags, o.document_type_source
       FROM person p JOIN person_import_origin o ON o.person_id = p.id WHERE p.document_number = $1`,
      [`30${base}`],
    )) as Array<Record<string, unknown>>;
    expect(stored).toEqual({
      document_type: 'CC',
      first_name: 'MARTA',
      last_name: 'SUAREZ',
      data_quality_flags: [],
      document_type_source: 'DECLARED_BY_OPERATOR',
    });
    const [job] = (await dataSource.query('SELECT options FROM staging_import WHERE id = $1', [preview.importId])) as Array<{
      options: Record<string, unknown>;
    }>;
    expect(job?.options).toEqual({ documentTypeSource: 'DECLARED_BY_OPERATOR', declaredDocumentType: 'CC', declaredBy: actor.id });
    await expectNoDocumentNumbers(preview.importId, [`30${base}`, `AB-${base}`, `31${base}`, `32${base}`, `33${base}`]);
  });

  it('con columna de tipo: acepta código o abreviatura, rechaza lo que no está en el catálogo; unicidad por el par', async () => {
    const base = tag();
    const rows: Cell[][] = [
      ['Tipo', 'Documento', 'Nombre', 'Correo'],
      ['C.C.', `40${base}`, 'UNO', `uno.${base}@unac.edu.co`],
      ['ce', `X${base}`, 'DOS', `dos.${base}@unac.edu.co`],
      ['XX', `41${base}`, 'TRES', `tres.${base}@unac.edu.co`],
      [null, `42${base}`, 'CUATRO', `cuatro.${base}@unac.edu.co`],
    ];
    const upload = await imports.upload(await workbook('Tipos', rows), 'tipos.xlsx', actor.id);
    const mapping = { documentType: 'A', documentNumber: 'B', fullName: 'C', email: 'D' };
    const preview = await imports.preview(upload.batchId, { sheet: 'Tipos', target: 'PERSONS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({
      toInsert: 3,
      quarantined: { DOCUMENT_TYPE_INVALID: 1 },
      flagged: { NAME_NOT_SPLIT: 3, DOCUMENT_TYPE_UNKNOWN: 1 },
    });
    const issues = await imports.issues(preview.importId, 1, 50);
    expect(issues.items).toEqual([
      expect.objectContaining({ rowNumber: 4, code: 'DOCUMENT_TYPE_INVALID', rawValue: null, detail: 'Tipo de documento «XX» fuera del catálogo' }),
    ]);
    await imports.confirm(preview.importId, actor.id);
    const stored = (await dataSource.query(
      `SELECT p.document_type, o.document_type_source FROM person p JOIN person_import_origin o ON o.person_id = p.id
       WHERE p.document_number = ANY($1) ORDER BY p.document_number`,
      [[`40${base}`, `42${base}`, `X${base}`]],
    )) as Array<Record<string, unknown>>;
    expect(stored).toEqual([
      { document_type: 'CC', document_type_source: 'COLUMN' },
      { document_type: null, document_type_source: 'UNKNOWN' },
      { document_type: 'CE', document_type_source: 'COLUMN' },
    ]);
    // Mismo número con otro tipo es otra persona: la unicidad es por el par (tipo, número).
    await dataSource.query(
      `INSERT INTO person (first_name, last_name, email, document_type, document_number) VALUES ('Par', 'Distinto', 'par@unac.edu.co', 'PA', $1)`,
      [`40${base}`],
    );
    await expect(
      dataSource.query(
        `INSERT INTO person (first_name, last_name, email, document_type, document_number) VALUES ('Par', 'Repetido', 'par2@unac.edu.co', 'CC', $1)`,
        [`40${base}`],
      ),
    ).rejects.toThrow(/person_document_type_document_number_key/);
    await expect(
      dataSource.query(
        `INSERT INTO person (first_name, last_name, email, document_type, document_number) VALUES ('Tipo', 'Raro', 'raro@unac.edu.co', 'PAS', $1)`,
        [`49${base}`],
      ),
    ).rejects.toThrow(/chk_person_document_type/);
  });

  it('rechaza mapeos ambiguos o políticas que no aplican a personas', async () => {
    const upload = await imports.upload(
      await workbook('Mapeo', [['Documento', 'Nombre', 'Nombres', 'Tipo'], [`50${tag()}`, 'A', 'B', 'CC']]),
      'mapeo.xlsx',
      actor.id,
    );
    const attempt = (request: Record<string, unknown>) =>
      imports.preview(upload.batchId, { sheet: 'Mapeo', target: 'PERSONS', mapping: { documentNumber: 'A' }, ...request } as never, actor.id);
    const fields = async (request: Record<string, unknown>) => {
      try {
        await attempt(request);
      } catch (error) {
        return (error as { details?: Array<{ field: string }> }).details?.map((item) => item.field) ?? [];
      }
      return ['<sin error>'];
    };
    expect(await fields({ mapping: { documentNumber: 'A', fullName: 'B', firstName: 'C' } })).toContain('fullName');
    expect(await fields({ mapping: { documentNumber: 'A', firstName: 'C' } })).toContain('fullName');
    expect(await fields({ mapping: { documentNumber: 'A', fullName: 'B', documentType: 'D' }, documentType: 'CC' })).toContain(
      'documentType',
    );
    expect(await fields({ mapping: { documentNumber: 'A', fullName: 'B' }, unknownCostCenters: 'create' })).toContain(
      'unknownCostCenters',
    );
    expect(await fields({ mapping: { fullName: 'B' } })).toContain('documentNumber');
    const assets = await imports
      .preview(upload.batchId, { sheet: 'Mapeo', target: 'COST_CENTERS', mapping: { code: 'A', name: 'B' }, documentType: 'CC' }, actor.id)
      .catch((error: { details?: Array<{ field: string }> }) => error.details?.map((item) => item.field));
    expect(assets).toContain('documentType');
  });
});
