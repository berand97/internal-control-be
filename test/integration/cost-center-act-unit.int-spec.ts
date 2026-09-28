// centroCosto.unidad en el acta: la unidad del centro VIGENTE A LA FECHA DEL ACTA, guardada en el snapshot
// document.data. Si el centro cambia de unidad después, leer el acta o re-renderizarla (reasignar un firmante) sigue
// mostrando la unidad de la emisión. Formato libre de prueba con una plantilla mínima armada en el test.
import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import PizZip from 'pizzip';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { CostCentersModule } from '../../src/modules/cost-centers/cost-centers.module.js';
import { CostCenterPlacementService } from '../../src/modules/cost-centers/services/cost-center-placement.service.js';
import { DocumentsModule } from '../../src/modules/documents/documents.module.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { DocumentFormatCatalogService } from '../../src/modules/documents/services/document-format-catalog.service.js';
import { SIGNATURE_PROVIDER, StubSignatureProvider } from '../../src/modules/documents/signature/signature-provider.js';
import { FeaturesModule } from '../../src/modules/features/features.module.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { createActor, createFreeTestFormat, dropTestFormat, scalar, useSharedStorage } from './helpers.js';

const FORMAT = 'IT-UNIDAD-ACTA';

class FakePdfConverter implements PdfConverter {
  toPdf(docx: Buffer): Promise<Buffer> {
    return Promise.resolve(Buffer.concat([Buffer.from('%PDF-1.7 simulado\n'), docx.subarray(0, 16)]));
  }
}

const template = (): Buffer => {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const lines = [
    'CENTRO|{{centroCosto.codigo}}|{{centroCosto.nombre}}|',
    'UNIDAD|{{centroCosto.unidad.codigo}}|{{centroCosto.unidad.nombre}}|',
    'RESPONSABLE|{{firmante.responsable.nombre}}|',
  ];
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines
      .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
      .join('')}</w:body></w:document>`,
  );
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
};

const docxText = (docx: Buffer): string =>
  new PizZip(docx).file('word/document.xml')?.asText().replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '') ?? '';

describe('Unidad del centro de costo en el acta, a la fecha de emisión (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let storageDir: string;
  let director: AuthenticatedUser;
  const created: { documents: string[]; templates: string[] } = { documents: [], templates: [] };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        TypeOrmModule.forFeature([...(dataSourceConfig.options.entities as Type<unknown>[])]),
        FeaturesModule,
        StorageModule,
        CostCentersModule,
        DocumentsModule,
      ],
    })
      .overrideProvider(SIGNATURE_PROVIDER)
      .useFactory({
        // El stub con reemisión (como el proveedor interno): reasignar un firmante re-renderiza el acta.
        factory: (stub: StubSignatureProvider) => Object.assign(Object.create(stub) as StubSignatureProvider, { reissue: () => Promise.resolve() }),
        inject: [StubSignatureProvider],
      })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new FakePdfConverter())
      .compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    engine = moduleRef.get(DocumentEngineService);
    storageDir = await useSharedStorage(dataSource);
    director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    await createFreeTestFormat(moduleRef.get(DocumentFormatCatalogService), FORMAT, director.id);
    const uploaded = await engine.uploadTemplate(
      FORMAT,
      { buffer: template(), originalname: 'unidad.docx' },
      { sgcVersion: '1', effectiveDate: '2026-01-01' },
      director.id,
    );
    created.templates.push(uploaded.id ?? '');
  });

  afterAll(async () => {
    const ids = created.documents;
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_request WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dropTestFormat(dataSource, FORMAT);
    await moduleRef.close();
  });

  it('el acta guarda la unidad vigente al emitir; mover el centro de unidad no cambia lo leído ni lo re-renderizado', async () => {
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const unit = (code: string, name: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO organizational_unit (code, name, unit_type, hierarchy_path) VALUES ($1, $2, 'DEPARTMENT', $3) RETURNING id`,
        [code, name, `/${code.toLowerCase()}`],
      );
    const before = await unit(`IT_ANTES_${tag}`, 'Unidad antes del cambio');
    const after = await unit(`IT_DESPUES_${tag}`, 'Unidad después del cambio');
    const centerId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name, organizational_unit_id) VALUES ($1, 'Centro del acta', $2) RETURNING id`,
      [`ACTA-${tag}`, before],
    );
    const person = (first: string, doc: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
         VALUES ($1, 'Unidad', $2, 'CC', $3, 'Cargo de prueba') RETURNING id`,
        [first, `${first.toLowerCase()}.${doc}@unac.edu.co`, doc],
      );
    const responsible = await person('Responsable', `7${Date.now().toString().slice(-8)}`);
    const replacement = await person('Reemplazo', `6${Date.now().toString().slice(-8)}`);

    const document = await engine.generate(
      { formatKey: FORMAT, costCenterId: centerId, responsiblePersonId: responsible, signers: { AUDITA: director.personId } },
      director.id,
    );
    created.documents.push(document.id);
    const unitInData = () =>
      scalar<Record<string, string>>(dataSource, `SELECT data->'centroCosto'->'unidad' FROM document WHERE id = $1`, [document.id]);
    expect(await unitInData()).toEqual({ codigo: `IT_ANTES_${tag}`, nombre: 'Unidad antes del cambio' });
    const firstKey = await scalar<string>(dataSource, 'SELECT docx_key FROM document WHERE id = $1', [document.id]);
    expect(docxText(await readFile(join(storageDir, firstKey)))).toContain(`UNIDAD|IT_ANTES_${tag}|Unidad antes del cambio|`);

    // El centro se mueve de unidad después de emitida el acta.
    await dataSource.transaction((manager) =>
      moduleRef.get(CostCenterPlacementService).change(
        manager,
        centerId,
        { unitId: after },
        { reason: 'Reorganización de prueba', actorId: director.id, ip: null, userAgent: null, source: 'MANUAL' },
      ),
    );
    expect(await scalar<string>(dataSource, 'SELECT organizational_unit_id FROM cost_center WHERE id = $1', [centerId])).toBe(after);
    expect(await unitInData()).toEqual({ codigo: `IT_ANTES_${tag}`, nombre: 'Unidad antes del cambio' });

    // Re-render real (reasignar el turno del responsable vuelve a armar el DOCX desde document.data).
    await engine.reassignSigner(document.id, 1, replacement, 'Cambio de responsable de prueba', director, {
      ipAddress: null,
      userAgent: null,
    });
    const secondKey = await scalar<string>(dataSource, 'SELECT docx_key FROM document WHERE id = $1', [document.id]);
    expect(secondKey).not.toBe(firstKey);
    const rerendered = docxText(await readFile(join(storageDir, secondKey)));
    expect(rerendered).toContain(`UNIDAD|IT_ANTES_${tag}|Unidad antes del cambio|`);
    expect(rerendered).toContain('RESPONSABLE|Reemplazo Unidad|');
    expect(rerendered).not.toContain('Unidad después del cambio');
    expect(await unitInData()).toEqual({ codigo: `IT_ANTES_${tag}`, nombre: 'Unidad antes del cambio' });

    // Un acta nueva del mismo centro ya lleva la unidad nueva.
    const next = await engine.generate(
      { formatKey: FORMAT, costCenterId: centerId, responsiblePersonId: responsible, signers: { AUDITA: director.personId } },
      director.id,
    );
    created.documents.push(next.id);
    expect(
      await scalar<Record<string, string>>(dataSource, `SELECT data->'centroCosto'->'unidad' FROM document WHERE id = $1`, [next.id]),
    ).toEqual({ codigo: `IT_DESPUES_${tag}`, nombre: 'Unidad después del cambio' });
  });
});
