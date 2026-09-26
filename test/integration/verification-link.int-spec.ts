import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { resolveSignatureVerifyUrl } from '../../src/config/signature-verify-url.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { createActor, useSharedStorage } from './helpers.js';

class BlankPdfConverter implements PdfConverter {
  async toPdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    return Buffer.from(await pdf.save());
  }
}

describe('Enlace de verificación del documento', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new BlankPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    // El job de documentos corre cada minuto: se detiene para que el test decida cuándo se procesa el outbox.
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('el detalle trae el código y la URL, y el código resuelve en la página pública', async () => {
    const director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    await engine.uploadTemplate(
      'OCI-17-90-INFORME',
      { buffer: await readFile('templates/formats/OCI-01-55-v2.docx'), originalname: 'plantilla.docx' },
      { sgcVersion: '1', effectiveDate: '2026-05-01' },
      director.id,
    );
    const document = await engine.generate({ formatKey: 'OCI-17-90-INFORME', signers: { AUDITA: director.personId } }, director.id);
    const token = (userId: string, personId: string) =>
      app.get(TokenService).signAccessToken({ id: userId, personId, username: 'x', roles: [], scopes: [], sessionId: randomUUID() });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/documents/${document.id}`)
      .set('Authorization', `Bearer ${token(director.id, director.personId)}`);
    expect(detail.status).toBe(200);
    const verification = detail.body.data.verification as { code: string; url: string };
    expect(verification.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(verification.url).toBe(`${resolveSignatureVerifyUrl(process.env)}/${verification.code}`);

    const publicPage = await request(app.getHttpServer()).get(`/api/v1/public/signatures/${verification.code}`);
    expect(publicPage.status).toBe(200);
    expect(publicPage.body.data).toMatchObject({ reference: verification.code, status: 'PENDING', integrity: 'INTACT' });

    const outsider = await createActor(dataSource);
    const hidden = await request(app.getHttpServer())
      .get(`/api/v1/documents/${document.id}`)
      .set('Authorization', `Bearer ${token(outsider.id, outsider.personId)}`);
    expect(hidden.status).toBe(403);
    expect(JSON.stringify(hidden.body)).not.toContain(verification.code);
  });

  it('en producción la URL pública es obligatoria, https y no local', () => {
    const production = { NODE_ENV: 'production' };
    expect(() => resolveSignatureVerifyUrl(production)).toThrow(/SIGNATURE_VERIFY_URL es obligatoria en producción/);
    expect(() => resolveSignatureVerifyUrl({ ...production, APP_PUBLIC_URL: 'https://control-interno.unac.edu.co' })).toThrow(/obligatoria/);
    expect(() => resolveSignatureVerifyUrl({ ...production, SIGNATURE_VERIFY_URL: 'http://localhost:4200/verificar-firma' })).toThrow(/https/);
    expect(() => resolveSignatureVerifyUrl({ ...production, SIGNATURE_VERIFY_URL: 'https://localhost/verificar-firma' })).toThrow(/pública/);
    expect(() => resolveSignatureVerifyUrl({ ...production, SIGNATURE_VERIFY_URL: 'https://10.0.0.5/verificar-firma' })).toThrow(/pública/);
    expect(() => resolveSignatureVerifyUrl({ ...production, SIGNATURE_VERIFY_URL: 'no es una url' })).toThrow(/válida/);
    expect(resolveSignatureVerifyUrl({ ...production, SIGNATURE_VERIFY_URL: 'https://control-interno.unac.edu.co/verificar-firma/' })).toBe(
      'https://control-interno.unac.edu.co/verificar-firma',
    );
    expect(resolveSignatureVerifyUrl({ NODE_ENV: 'development' })).toBe('http://localhost:4200/verificar-firma');
  });

  it('la aplicación no arranca en producción sin la variable', async () => {
    const saved = { NODE_ENV: process.env['NODE_ENV'], SIGNATURE_VERIFY_URL: process.env['SIGNATURE_VERIFY_URL'] };
    process.env['NODE_ENV'] = 'production';
    delete process.env['SIGNATURE_VERIFY_URL'];
    vi.resetModules();
    try {
      const boot = async () => {
        const { AppModule: FreshAppModule } = await import('../../src/app.module.js');
        const moduleRef = await Test.createTestingModule({ imports: [FreshAppModule] }).compile();
        await moduleRef.close();
      };
      await expect(boot()).rejects.toThrow(/SIGNATURE_VERIFY_URL es obligatoria en producción/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });
});
