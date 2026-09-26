import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { DocumentsModule } from '../../src/modules/documents/documents.module.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { SIGNATURE_PROVIDER, StubSignatureProvider } from '../../src/modules/documents/signature/signature-provider.js';
import { FeaturesModule } from '../../src/modules/features/features.module.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const CLEANED_FORMATS = ['OCI-01-55', 'OCI-17-89', 'OCI-01-65'];
const snapshot: {
  templates: string[];
  sequences: Array<{ format_key: string; period: string; current_value: string }>;
} = { templates: [], sequences: [] };

class FakePdfConverter implements PdfConverter {
  failNext = false;
  toPdf(docx: Buffer): Promise<Buffer> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('conversión simulada fallida'));
    }
    return Promise.resolve(Buffer.concat([Buffer.from('%PDF-1.7 simulado\n'), docx.subarray(0, 16)]));
  }
}

const boot = async (converter: PdfConverter | null): Promise<TestingModule> => {
  let builder = Test.createTestingModule({
    imports: [
      AppConfigModule,
      DatabaseModule,
      TypeOrmModule.forFeature([...(dataSourceConfig.options.entities as Type<unknown>[])]),
      FeaturesModule,
      StorageModule,
      DocumentsModule,
    ],
  });
  builder = builder
    .overrideProvider(SIGNATURE_PROVIDER)
    .useFactory({ factory: (stub: StubSignatureProvider) => stub, inject: [StubSignatureProvider] });
  if (converter) {
    builder = builder.overrideProvider(PDF_CONVERTER).useValue(converter);
  }
  const moduleRef = await builder.compile();
  await moduleRef.init();
  return moduleRef;
};

const documentText = (docx: Buffer): string =>
  ['word/document.xml', 'word/header1.xml']
    .map((name) => new PizZip(docx).file(name)?.asText().replace(/<[^>]+>/g, '') ?? '')
    .join('\n');

describe('Motor de documentos (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let stub: StubSignatureProvider;
  const converter = new FakePdfConverter();
  let storageDir: string;
  let director: AuthenticatedUser;
  let outsider: AuthenticatedUser;
  let fixture: { costCenterId: string; responsibleId: string; auditorId: string; assetIds: string[] };

  const sequence = (formatKey: string, period = '') =>
    scalar<string | null>(
      dataSource,
      'SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = $2',
      [formatKey, period],
    ).then((value) => (value === undefined || value === null ? null : Number(value)));

  const request = (formatKey = 'OCI-01-55') => ({
    formatKey,
    costCenterId: fixture.costCenterId,
    responsiblePersonId: fixture.responsibleId,
    assetIds: fixture.assetIds,
    signers: { AUDITA: fixture.auditorId, ENTREGA: fixture.auditorId, CONTROL_INTERNO: fixture.auditorId, CONTABILIDAD: fixture.auditorId },
    assetNotes: { [fixture.assetIds[1] ?? '']: 'No activo' },
  });

  beforeAll(async () => {
    moduleRef = await boot(converter);
    dataSource = moduleRef.get(DataSource);
    engine = moduleRef.get(DocumentEngineService);
    stub = moduleRef.get(StubSignatureProvider);
    storageDir = await useSharedStorage(dataSource);
    snapshot.templates = (
      (await dataSource.query('SELECT id FROM document_template_version WHERE format_key = ANY($1)', [CLEANED_FORMATS])) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    snapshot.sequences = (await dataSource.query(
      'SELECT format_key, period, current_value FROM document_sequence WHERE format_key = ANY($1)',
      [CLEANED_FORMATS],
    )) as typeof snapshot.sequences;

    director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    outsider = await createActor(dataSource);

    const person = (first: string, last: string, doc: string, title: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
         VALUES ($1, $2, $3, 'CC', $4, $5) RETURNING id`,
        [first, last, `${first.toLowerCase()}.${doc}@unac.edu.co`, doc, title],
      );
    const costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('4330', 'Departamento de Gestión del Talento Humano') RETURNING id`,
    );
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('IT_DOCS', 'Documentos', FALSE) RETURNING id`,
    );
    const assetIds: string[] = [];
    for (const [code, description, legacy] of [
      ['XLS-16762', 'MUEBLE DE MADERA BIBLIOTECA EMPOTRADO', '4157'],
      ['XLS-26668', 'TELEFONO IP GRANDSTREAM 2 LINEAS', '26343'],
    ] as const) {
      const id = await scalar<string>(
        dataSource,
        `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
           current_cost_center_id, created_by, physical_condition)
         VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2020-01-01', $4, $5, 'GOOD')
         RETURNING id`,
        [code, description, categoryId, costCenterId, director.id],
      );
      await dataSource.query(
        `INSERT INTO asset_identifier (asset_id, identifier_type, value, origin) VALUES ($1, 'LEGACY_CODE', $2, 'IMPORTED')`,
        [id, legacy],
      );
      assetIds.push(id);
    }
    fixture = {
      costCenterId,
      responsibleId: await person('Laura', 'Gómez Prueba', '1000000001', 'Asociada de Talento Humano'),
      auditorId: await person('Auditora', 'Control Prueba', '1000000002', 'Control Interno'),
      assetIds,
    };

    const template = await readFile(TEMPLATE);
    for (const formatKey of ['OCI-01-55', 'OCI-17-89', 'OCI-01-65']) {
      await engine.uploadTemplate(
        formatKey,
        { buffer: template, originalname: 'OCI-01-55-v2.docx' },
        { sgcVersion: '2', effectiveDate: '2026-09-08' },
        director.id,
      );
    }
  });

  afterAll(async () => {
    // Deja la BD compartida como estaba (plantillas, actas y consecutivos de estos formatos): loans espera OCI-01-65
    // sin plantilla y otros archivos esperan el consecutivo inicial de OCI-01-55, sea cual sea el orden de los archivos.
    const templates = (
      (await dataSource.query('SELECT id FROM document_template_version WHERE format_key = ANY($1) AND NOT (id = ANY($2))', [
        CLEANED_FORMATS,
        snapshot.templates,
      ])) as Array<{ id: string }>
    ).map((row) => row.id);
    const ids = (
      (await dataSource.query('SELECT id FROM document WHERE template_version_id = ANY($1)', [templates])) as Array<{ id: string }>
    ).map((row) => row.id);
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_request WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = ANY($1)', [templates]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = ANY($1)', [CLEANED_FORMATS]);
    for (const sequence of snapshot.sequences) {
      await dataSource.query('INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)', [
        sequence.format_key,
        sequence.period,
        sequence.current_value,
      ]);
    }
    await moduleRef.close();
  });

  it('genera el OCI-01-55 real con datos del sistema, continúa el consecutivo y queda pendiente de firma', async () => {
    const document = await engine.generate(request(), director.id);
    expect(document).toMatchObject({ formatKey: 'OCI-01-55', number: '0093', status: 'PENDING_SIGNATURE', pdfDriver: 'project' });

    const [row] = (await dataSource.query('SELECT * FROM document WHERE id = $1', [document.id])) as Array<Record<string, string>>;
    expect(row).toMatchObject({ docx_driver: 'project', pdf_driver: 'project', signature_provider: 'stub' });
    const docx = await readFile(join(storageDir, row?.['docx_key'] ?? ''));
    const text = documentText(docx);
    expect(text).toContain('0093');
    expect(text).toContain('Laura Gómez Prueba');
    expect(text).toContain('1000000001');
    expect(text).toContain('4330 Departamento de Gestión del Talento Humano');
    expect(text).toContain('MUEBLE DE MADERA BIBLIOTECA EMPOTRADO');
    expect(text).toContain('TELEFONO IP GRANDSTREAM 2 LINEAS');
    expect(text).toContain('No activo');
    expect(text).toContain('Auditora Control Prueba');
    expect(text).toContain('OCI-01-55');
    expect(text).toContain('2026-09-08');
    expect(text).not.toContain('{{');
    const pdf = await readFile(join(storageDir, row?.['pdf_key'] ?? ''));
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');

    expect(await dataSource.query(
      `SELECT sign_order, role, signer_name, status FROM document_signature WHERE document_id = $1 ORDER BY sign_order`,
      [document.id],
    )).toEqual([
      { sign_order: 1, role: 'RECIBE', signer_name: 'Laura Gómez Prueba', status: 'PENDING' },
      { sign_order: 2, role: 'AUDITA', signer_name: 'Auditora Control Prueba', status: 'PENDING' },
    ]);
  });

  it('una falla dentro de la transacción no consume consecutivo ni deja documento', async () => {
    const before = await sequence('OCI-01-55');
    const documentsBefore = await scalar<string>(dataSource, 'SELECT count(*) FROM document');
    converter.failNext = true;
    await expect(engine.generate(request(), director.id)).rejects.toThrow('conversión simulada fallida');
    expect(await sequence('OCI-01-55')).toBe(before);
    expect(await scalar<string>(dataSource, 'SELECT count(*) FROM document')).toBe(documentsBefore);
    expect((await engine.generate(request(), director.id)).number).toBe('0094');
  });

  it('cada formato tiene su propio consecutivo; el préstamo es anual', async () => {
    expect((await engine.generate(request('OCI-17-89'), director.id)).number).toBe('00144');
    expect((await engine.generate(request('OCI-01-65'), director.id)).number).toBe('2026-0002');
    expect((await engine.generate(request('OCI-01-55'), director.id)).number).toBe('0095');
    expect(await sequence('OCI-17-89')).toBe(144);
    expect(await sequence('OCI-01-65', '2026')).toBe(2);
  });

  it('el número es único por formato', async () => {
    const [existing] = (await dataSource.query(
      `SELECT template_version_id FROM document WHERE format_key = 'OCI-01-55' LIMIT 1`,
    )) as Array<{ template_version_id: string }>;
    await expect(
      dataSource.query(
        `INSERT INTO document (format_key, number, period, sequence_value, template_version_id, status, data,
           docx_driver, docx_key, docx_hash, pdf_driver, pdf_key, pdf_hash)
         VALUES ('OCI-01-55', '0093', '', 93, $1, 'PENDING_SIGNATURE', '{}', 'project', 'x', repeat('a', 64), 'project', 'y', repeat('a', 64))`,
        [existing?.template_version_id],
      ),
    ).rejects.toThrow(/uq_document_number/);
  });

  it('sin plantilla vigente falla explícitamente y no consume consecutivo', async () => {
    await expect(engine.generate(request('OCI-21-37'), director.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_ACTIVE' });
    expect(await sequence('OCI-21-37')).toBeNull();
  });

  it('la firma es un paso aparte: el stub la completa y el documento pasa a firmado', async () => {
    const document = await engine.generate(request(), director.id);
    const reference = `stub-${document.id}`;
    stub.complete(reference, 1);
    expect((await engine.syncSignatures(document.id)).status).toBe('PENDING_SIGNATURE');
    stub.complete(reference, 2);
    const signed = await engine.syncSignatures(document.id);
    expect(signed.status).toBe('SIGNED');
    expect(signed.signatures.map((signature) => signature['status'])).toEqual(['SIGNED', 'SIGNED']);
  });

  it('un proceso encola la solicitud en su transacción; el motor la genera aparte y un fallo no toca el proceso', async () => {
    const ok = await dataSource.transaction((manager) => engine.enqueue(manager, request(), director.id));
    const broken = await dataSource.transaction((manager) =>
      engine.enqueue(manager, { ...request(), assetIds: ['00000000-0000-4000-8000-000000000000'] }, director.id),
    );
    const before = await sequence('OCI-01-55');
    expect(await engine.processPending()).toEqual({ generated: 1, failed: 1 });
    const requests = (await dataSource.query(
      'SELECT id, status, document_id, last_error FROM document_request WHERE id = ANY($1)',
      [[ok, broken]],
    )) as Array<{ id: string; status: string; document_id: string | null; last_error: string | null }>;
    expect(requests.find((row) => row.id === ok)).toMatchObject({ status: 'GENERATED' });
    expect(requests.find((row) => row.id === ok)?.document_id).not.toBeNull();
    expect(requests.find((row) => row.id === broken)).toMatchObject({ status: 'FAILED', document_id: null });
    expect(requests.find((row) => row.id === broken)?.last_error).toContain('activos inexistentes');
    expect(await sequence('OCI-01-55')).toBe((before ?? 0) + 1);
  });

  it('descarga con el permiso de lectura del proceso, no con storage:manage', async () => {
    const document = await engine.generate(request(), director.id);
    const file = await engine.download(document.id, 'pdf', director.id);
    expect(file.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(file.fileName).toBe(`OCI-01-55-${document.number}.pdf`);
    await expect(engine.download(document.id, 'pdf', outsider.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    await expect(engine.generate(request(), outsider.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });
});

describe.runIf(Boolean(process.env['GOTENBERG_URL']))('Motor de documentos con Gotenberg real', () => {
  it('convierte el OCI-01-55 real a PDF con LibreOffice', async () => {
    const moduleRef = await boot(null);
    const dataSource = moduleRef.get(DataSource);
    const engine = moduleRef.get(DocumentEngineService);
    await useSharedStorage(dataSource);
    try {
      const actor = await createActor(dataSource);
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
        [actor.id],
      );
      await engine.uploadTemplate(
        'OCI-01-55',
        { buffer: await readFile(TEMPLATE), originalname: 'OCI-01-55-v2.docx' },
        { sgcVersion: '2', effectiveDate: '2026-09-09' },
        actor.id,
      );
      const document = await engine.generate(
        {
          formatKey: 'OCI-01-55',
          costCenterId: await scalar<string>(dataSource, `SELECT id FROM cost_center WHERE external_code = '4330'`),
          responsiblePersonId: actor.personId,
          signers: { AUDITA: actor.personId },
        },
        actor.id,
      );
      const pdf = await engine.download(document.id, 'pdf', actor.id);
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.body.length).toBeGreaterThan(10_000);
    } finally {
      await moduleRef.close();
    }
  });
});
