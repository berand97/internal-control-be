import { Inject, Injectable, Module, type OnModuleInit, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import PizZip from 'pizzip';
import { DataSource, type EntityManager } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { DocumentsController } from '../../src/modules/documents/documents.controller.js';
import { DocumentsModule } from '../../src/modules/documents/documents.module.js';
import {
  DocumentLifecycleRegistry,
  type DocumentLifecycleEvent,
  type DocumentLifecyclePhase,
} from '../../src/modules/documents/lifecycle/document-lifecycle.registry.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import {
  SIGNATURE_PROVIDER,
  type SignatureProvider,
  type SignatureRequest,
  type SignatureStatus,
  type SignerStatus,
} from '../../src/modules/documents/signature/signature-provider.js';
import { FeaturesModule } from '../../src/modules/features/features.module.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';

const ENTITY = 'IT_PROCESS';
const LIFECYCLE_FORMAT = 'OCI-21-37';
const ROLES_FORMAT = 'OCI-01-65';

class FakePdfConverter implements PdfConverter {
  toPdf(docx: Buffer): Promise<Buffer> {
    return Promise.resolve(Buffer.concat([Buffer.from('%PDF-1.7 simulado\n'), docx.subarray(0, 16)]));
  }
}

/** Proveedor de firma guionado: el test decide el estado de cada turno. */
class ScriptedSignatureProvider implements SignatureProvider {
  readonly name = 'scripted';
  private readonly envelopes = new Map<string, Map<number, SignerStatus>>();

  request(input: SignatureRequest): Promise<{ readonly externalReference: string }> {
    const reference = `scripted-${input.documentId}`;
    this.envelopes.set(
      reference,
      new Map(input.signers.map((signer) => [signer.order, { order: signer.order, status: 'PENDING' as const }])),
    );
    return Promise.resolve({ externalReference: reference });
  }

  status(reference: string): Promise<ReadonlyArray<SignerStatus>> {
    return Promise.resolve([...(this.envelopes.get(reference)?.values() ?? [])]);
  }

  signedDocument(reference: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(`%PDF-1.7 firmado ${reference}`));
  }

  reissue(): Promise<void> {
    return Promise.resolve();
  }

  mark(documentId: string, order: number, status: SignatureStatus): void {
    this.envelopes.get(`scripted-${documentId}`)?.set(order, {
      order,
      status,
      ...(status === 'PENDING' ? {} : { signedAt: new Date() }),
    });
  }
}

/** Un proceso de negocio como lo harían entrega o préstamo: registra su manejador sin tocar el módulo de documentos. */
@Injectable()
class ItProcess implements OnModuleInit {
  readonly failures: Record<DocumentLifecyclePhase, number> = { onGenerated: 0, onSigned: 0, onRejected: 0 };
  readonly events: Array<{ phase: DocumentLifecyclePhase; event: DocumentLifecycleEvent }> = [];

  constructor(@Inject(DocumentLifecycleRegistry) private readonly lifecycle: DocumentLifecycleRegistry) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: ENTITY,
      onGenerated: (manager, event) => this.apply(manager, 'onGenerated', event),
      onSigned: (manager, event) => this.apply(manager, 'onSigned', event),
      onRejected: (manager, event) => this.apply(manager, 'onRejected', event),
    });
  }

  private async apply(manager: EntityManager, phase: DocumentLifecyclePhase, event: DocumentLifecycleEvent): Promise<void> {
    // El efecto se escribe ANTES de fallar: si la transacción no se revierte, el test lo ve.
    await manager.query('INSERT INTO it_lifecycle_effect (entity_id, phase, document_id) VALUES ($1, $2, $3)', [
      event.entityId,
      phase,
      event.documentId,
    ]);
    if (this.failures[phase] > 0) {
      this.failures[phase] -= 1;
      throw new Error(`fallo simulado del proceso en ${phase}`);
    }
    this.events.push({ phase, event });
  }
}

@Module({ imports: [DocumentsModule], providers: [ItProcess] })
class ItProcessModule {}

/** DOCX mínimo que usa exactamente los placeholders del contrato de la plantilla OCI-01-65. */
const rolesTemplate = (): Buffer => {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const lines = ['entrega', 'recibe', 'audita'].map(
    (role) =>
      `${role.toUpperCase()}|{{firmante.${role}.nombre}}|{{firmante.${role}.documento}}|{{firmante.${role}.cargo}}|`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(paragraph).join('')}</w:body></w:document>`,
  );
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
};

const docxText = (docx: Buffer): string =>
  new PizZip(docx).file('word/document.xml')?.asText().replace(/<[^>]+>/g, '\n') ?? '';

describe('Ciclo de vida del acta: el proceso que la originó se entera y aplica sus efectos (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let registry: DocumentLifecycleRegistry;
  let itProcess: ItProcess;
  let provider: ScriptedSignatureProvider;
  let director: AuthenticatedUser;
  const people = { responsable: '', auditora: '', entrega: '', reemplazo: '' };
  const templateIds: string[] = [];
  let sequencesBefore: Array<{ format_key: string; period: string; current_value: string }> = [];

  const person = (first: string, doc: string, title: string) =>
    scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Ciclo', $2, 'CC', $3, $4) RETURNING id`,
      [first, `ciclo.${doc}@unac.edu.co`, doc, title],
    );

  const drain = async () => {
    // processPending también toma solicitudes que otros archivos de prueba dejaron: el límite alto asegura las nuestras.
    await engine.processPending(1000);
  };

  const enqueue = (entityId: string) =>
    dataSource.transaction((manager) =>
      engine.enqueue(
        manager,
        {
          formatKey: LIFECYCLE_FORMAT,
          entityType: ENTITY,
          entityId,
          responsiblePersonId: people.responsable,
          signers: { AUDITA: people.auditora },
        },
        null,
      ),
    );

  const generated = async (entityId: string) => {
    await enqueue(entityId);
    await drain();
    const state = await registry.stateFor(ENTITY, entityId);
    const documentId = state.documents[0]?.documentId;
    if (!documentId) {
      throw new Error(`No se generó el acta: ${JSON.stringify(state)}`);
    }
    return documentId;
  };

  const effects = (entityId: string) =>
    dataSource.query('SELECT phase, document_id FROM it_lifecycle_effect WHERE entity_id = $1 ORDER BY id', [
      entityId,
    ]) as Promise<Array<{ phase: string; document_id: string }>>;

  const row = async (documentId: string) =>
    (
      (await dataSource.query(
        `SELECT status, signed_at, signed_pdf_key, lifecycle_error, lifecycle_attempts,
                (SELECT array_agg(status ORDER BY sign_order) FROM document_signature WHERE document_id = d.id) AS signatures
         FROM document d WHERE id = $1`,
        [documentId],
      )) as Array<{
        status: string;
        signed_at: Date | null;
        signed_pdf_key: string | null;
        lifecycle_error: string | null;
        lifecycle_attempts: number;
        signatures: string[];
      }>
    )[0];

  beforeAll(async () => {
    provider = new ScriptedSignatureProvider();
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        TypeOrmModule.forFeature([...(dataSourceConfig.options.entities as Type<unknown>[])]),
        FeaturesModule,
        StorageModule,
        DocumentsModule,
        ItProcessModule,
      ],
    })
      .overrideProvider(SIGNATURE_PROVIDER)
      .useValue(provider)
      .overrideProvider(PDF_CONVERTER)
      .useValue(new FakePdfConverter())
      .compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    engine = moduleRef.get(DocumentEngineService);
    registry = moduleRef.get(DocumentLifecycleRegistry);
    itProcess = moduleRef.get(ItProcess);
    await useSharedStorage(dataSource);
    await dataSource.query(
      `CREATE TABLE it_lifecycle_effect (id SERIAL PRIMARY KEY, entity_id UUID, phase TEXT NOT NULL, document_id UUID NOT NULL)`,
    );
    sequencesBefore = (await dataSource.query(
      'SELECT format_key, period, current_value FROM document_sequence WHERE format_key = ANY($1)',
      [[LIFECYCLE_FORMAT, ROLES_FORMAT]],
    )) as typeof sequencesBefore;

    director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    const tag = Date.now().toString().slice(-7);
    people.responsable = await person('Responsable', `71${tag}`, 'Coordinadora de laboratorio');
    people.auditora = await person('Auditora', `72${tag}`, 'Profesional de Control Interno');
    people.entrega = await person('Entregador', `73${tag}`, 'Almacenista');
    people.reemplazo = await person('Reemplazo', `74${tag}`, 'Auxiliar de almacén');

    // Vigente hoy, para ganarle a cualquier plantilla anterior del mismo formato; se borra en afterAll.
    const today = new Date().toISOString().slice(0, 10);
    for (const [formatKey, buffer] of [
      [LIFECYCLE_FORMAT, await readFile('templates/formats/OCI-01-55-v2.docx')],
      [ROLES_FORMAT, rolesTemplate()],
    ] as const) {
      const uploaded = await engine.uploadTemplate(
        formatKey,
        { buffer, originalname: 'plantilla.docx' },
        { sgcVersion: '9', effectiveDate: today },
        director.id,
      );
      templateIds.push(uploaded.id ?? '');
    }
  });

  afterAll(async () => {
    // Deja la BD compartida como estaba: otros archivos esperan OCI-21-37 sin plantilla y el consecutivo de OCI-01-65.
    const documents = (await dataSource.query('SELECT id FROM document WHERE template_version_id = ANY($1)', [
      templateIds,
    ])) as Array<{ id: string }>;
    const ids = documents.map((item) => item.id);
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE document_id = ANY($1) OR payload->>'entityType' = $2`, [
      ids,
      ENTITY,
    ]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = ANY($1)', [templateIds]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = ANY($1)', [[LIFECYCLE_FORMAT, ROLES_FORMAT]]);
    for (const sequence of sequencesBefore) {
      await dataSource.query('INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)', [
        sequence.format_key,
        sequence.period,
        sequence.current_value,
      ]);
    }
    await dataSource.query('DROP TABLE it_lifecycle_effect');
    await moduleRef.close();
  });

  it('onGenerated corre en la transacción del outbox; si falla no queda acta ni consecutivo y la solicitud trae el error', async () => {
    const pendingEntity = randomUUID();
    await enqueue(pendingEntity);
    expect(await registry.stateFor(ENTITY, pendingEntity)).toMatchObject({
      generation: 'PENDING',
      requests: [expect.objectContaining({ status: 'PENDING', lastError: null, documentId: null })],
      documents: [],
    });

    await drain();
    const done = await registry.stateFor(ENTITY, pendingEntity);
    expect(done.generation).toBe('GENERATED');
    expect(done.documents).toHaveLength(1);

    const failingEntity = randomUUID();
    const sequenceBefore = await scalar<string | undefined>(
      dataSource,
      `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
      [LIFECYCLE_FORMAT],
    );
    itProcess.failures.onGenerated = 1;
    await enqueue(failingEntity);
    await drain();
    const failed = await registry.stateFor(ENTITY, failingEntity);
    expect(failed.generation).toBe('FAILED');
    expect(failed.documents).toEqual([]);
    expect(failed.requests[0]).toMatchObject({ status: 'FAILED', attempts: 1, documentId: null });
    expect(failed.requests[0]?.lastError).toBe(`${ENTITY}.onGenerated: fallo simulado del proceso en onGenerated`);
    expect(await effects(failingEntity)).toEqual([]);
    expect(
      await scalar<string | undefined>(
        dataSource,
        `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
        [LIFECYCLE_FORMAT],
      ),
    ).toBe(sequenceBefore);

    // El siguiente intento del job la genera y el proceso se entera.
    await drain();
    const recovered = await registry.stateFor(ENTITY, failingEntity);
    expect(recovered.generation).toBe('GENERATED');
    expect(recovered.requests[0]).toMatchObject({ status: 'GENERATED', attempts: 2, lastError: null });
    expect(recovered.documents).toEqual([
      expect.objectContaining({ formatKey: LIFECYCLE_FORMAT, status: 'PENDING_SIGNATURE', lifecycleError: null }),
    ]);
    expect(recovered.requests[0]?.documentId).toBe(recovered.documents[0]?.documentId);
    expect(await effects(failingEntity)).toEqual([
      { phase: 'onGenerated', document_id: recovered.documents[0]?.documentId },
    ]);
    const event = itProcess.events.find((item) => item.event.entityId === failingEntity)?.event;
    expect(event).toMatchObject({
      formatKey: LIFECYCLE_FORMAT,
      entityType: ENTITY,
      signersByRole: { RESPONSABLE: people.responsable, AUDITA: people.auditora },
    });

    expect(await registry.stateFor(ENTITY, randomUUID())).toEqual(
      expect.objectContaining({ generation: 'NONE', requests: [], documents: [] }),
    );
  });

  it('onSigned corre una sola vez, en la transición a SIGNED, con los firmantes finales', async () => {
    const entityId = randomUUID();
    const documentId = await generated(entityId);

    provider.mark(documentId, 1, 'SIGNED');
    await engine.syncSignatures(documentId);
    expect((await row(documentId))?.status).toBe('PENDING_SIGNATURE');
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated']);

    provider.mark(documentId, 2, 'SIGNED');
    // Dos sincronizaciones a la vez: la fila bloqueada garantiza una sola transición.
    await Promise.all([engine.syncSignatures(documentId), engine.syncSignatures(documentId), engine.syncSignatures(documentId)]);
    await engine.syncSignatures(documentId);
    const signed = await row(documentId);
    expect(signed).toMatchObject({ status: 'SIGNED', lifecycle_error: null, signatures: ['SIGNED', 'SIGNED'] });
    expect(signed?.signed_at).not.toBeNull();
    expect(signed?.signed_pdf_key).toMatch(/-firmado\.pdf$/);
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated', 'onSigned']);
    const event = itProcess.events.find((item) => item.phase === 'onSigned' && item.event.documentId === documentId)?.event;
    expect(event?.signers.map((signer) => [signer.order, signer.role, signer.personId, signer.status])).toEqual([
      [1, 'RESPONSABLE', people.responsable, 'SIGNED'],
      [2, 'AUDITA', people.auditora, 'SIGNED'],
    ]);
  });

  it('si onSigned falla el acta NO queda SIGNED: sigue pendiente con todas las firmas, el error visible y el job la reintenta', async () => {
    const entityId = randomUUID();
    const documentId = await generated(entityId);
    provider.mark(documentId, 1, 'SIGNED');
    provider.mark(documentId, 2, 'SIGNED');
    itProcess.failures.onSigned = 2;

    const detail = await engine.syncSignatures(documentId);
    expect(detail).toMatchObject({
      status: 'PENDING_SIGNATURE',
      currentTurn: null,
      lifecycleError: `${ENTITY}.onSigned: fallo simulado del proceso en onSigned`,
      signedPdfSha256: null,
    });
    expect(detail.lifecycleFailedAt).toBeInstanceOf(Date);
    expect(await row(documentId)).toMatchObject({
      status: 'PENDING_SIGNATURE',
      signed_at: null,
      signed_pdf_key: null,
      lifecycle_attempts: 1,
      signatures: ['SIGNED', 'SIGNED'],
    });
    // El efecto que el manejador alcanzó a escribir se revirtió con la transición.
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated']);
    expect((await registry.stateFor(ENTITY, entityId)).documents[0]).toMatchObject({
      status: 'PENDING_SIGNATURE',
      lifecycleError: `${ENTITY}.onSigned: fallo simulado del proceso en onSigned`,
      lifecycleAttempts: 1,
    });

    // El sync manual reintenta; vuelve a fallar y cuenta el intento.
    await engine.syncSignatures(documentId);
    expect(await row(documentId)).toMatchObject({ status: 'PENDING_SIGNATURE', lifecycle_attempts: 2 });

    // El job lo reintenta y esta vez el proceso aplica su efecto: la transición y el efecto quedan juntos.
    const retried = await engine.retryLifecycle(1000);
    expect(retried.retried).toBeGreaterThanOrEqual(1);
    const signed = await row(documentId);
    expect(signed).toMatchObject({ status: 'SIGNED', lifecycle_error: null, signatures: ['SIGNED', 'SIGNED'] });
    expect(signed?.signed_pdf_key).toMatch(/-firmado\.pdf$/);
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated', 'onSigned']);
    expect((await engine.detail(documentId)).lifecycleError).toBeNull();

    // Ya firmada, el job no la vuelve a tocar.
    await engine.retryLifecycle(1000);
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated', 'onSigned']);
  });

  it('el rechazo avisa al proceso una vez; si onRejected falla el acta sigue pendiente, sin turno, hasta que el proceso lo acepta', async () => {
    const entityId = randomUUID();
    const documentId = await generated(entityId);
    provider.mark(documentId, 1, 'REJECTED');
    itProcess.failures.onRejected = 1;

    const stalled = await engine.syncSignatures(documentId);
    expect(stalled).toMatchObject({
      status: 'PENDING_SIGNATURE',
      currentTurn: null,
      lifecycleError: `${ENTITY}.onRejected: fallo simulado del proceso en onRejected`,
    });
    expect((await row(documentId))?.signatures).toEqual(['REJECTED', 'PENDING']);
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated']);

    await engine.syncSignatures(documentId);
    await engine.syncSignatures(documentId);
    expect(await row(documentId)).toMatchObject({ status: 'REJECTED', lifecycle_error: null, signed_at: null, signed_pdf_key: null });
    expect((await effects(entityId)).map((item) => item.phase)).toEqual(['onGenerated', 'onRejected']);
    expect((await registry.stateFor(ENTITY, entityId)).documents[0]).toMatchObject({ status: 'REJECTED', lifecycleError: null });
  });

  it('un entityType con proceso registrado no se genera por POST /documents', async () => {
    const controller = moduleRef.get(DocumentsController);
    expect(() =>
      controller.generate(
        { formatKey: LIFECYCLE_FORMAT, entityType: ENTITY, entityId: randomUUID(), responsiblePersonId: people.responsable },
        director,
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => registry.register({ entityType: ENTITY })).toThrow(/Ya hay un manejador/);
  });

  it('el contexto nombra a cada firmante por su rol y la reasignación lo recalcula en el acta reemitida', async () => {
    const storage = moduleRef.get(StorageService);
    const document = await engine.generate(
      {
        formatKey: ROLES_FORMAT,
        responsiblePersonId: people.responsable,
        signers: { ENTREGA: people.entrega, AUDITA: people.auditora },
      },
      director.id,
    );
    const data = async () =>
      (
        (await dataSource.query('SELECT data, docx_driver, docx_key FROM document WHERE id = $1', [document.id])) as Array<{
          data: { firmante: Record<string, { nombre: string; documento: string; cargo: string }>; firmantes: unknown[] };
          docx_driver: 'project';
          docx_key: string;
        }>
      )[0];
    const original = await data();
    const doc = (id: string) => scalar<string>(dataSource, 'SELECT document_number FROM person WHERE id = $1', [id]);
    expect(original?.data.firmante).toEqual({
      entrega: { nombre: 'Entregador Ciclo', documento: await doc(people.entrega), cargo: 'Almacenista' },
      recibe: { nombre: 'Responsable Ciclo', documento: await doc(people.responsable), cargo: 'Coordinadora de laboratorio' },
      audita: { nombre: 'Auditora Ciclo', documento: await doc(people.auditora), cargo: 'Profesional de Control Interno' },
    });
    expect(original?.data.firmantes).toHaveLength(3);
    const originalText = docxText(await storage.getFrom(original?.docx_driver ?? 'project', original?.docx_key ?? ''));
    expect(originalText).toContain('ENTREGA|Entregador Ciclo|');
    expect(originalText).toContain('RECIBE|Responsable Ciclo|');
    expect(originalText).toContain('AUDITA|Auditora Ciclo|');
    expect(originalText).not.toContain('{{');

    await engine.reassignSigner(document.id, 1, people.reemplazo, 'El almacenista titular está de licencia', director, {
      ipAddress: null,
      userAgent: null,
    });
    const reissued = await data();
    expect(reissued?.data.firmante['entrega']).toEqual({
      nombre: 'Reemplazo Ciclo',
      documento: await doc(people.reemplazo),
      cargo: 'Auxiliar de almacén',
    });
    expect(reissued?.data.firmante['recibe']?.nombre).toBe('Responsable Ciclo');
    expect(reissued?.docx_key).not.toBe(original?.docx_key);
    const reissuedText = docxText(await storage.getFrom(reissued?.docx_driver ?? 'project', reissued?.docx_key ?? ''));
    expect(reissuedText).toContain(`ENTREGA|Reemplazo Ciclo|${await doc(people.reemplazo)}|Auxiliar de almacén|`);
    expect(reissuedText).not.toContain('Entregador Ciclo');
    expect(reissuedText).toContain('AUDITA|Auditora Ciclo|');
  });
});
