import type { TestingModule } from '@nestjs/testing';
import PizZip from 'pizzip';
import { readFile } from 'node:fs/promises';
import { renderDocx } from '../../src/modules/document-templates/domain/docx-template.js';
import { DocumentTemplatesModule } from '../../src/modules/document-templates/document-templates.module.js';
import { DocumentTemplatesService } from '../../src/modules/document-templates/services/document-templates.service.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { bootModules, createActor } from './helpers.js';
import { DataSource } from 'typeorm';

const documentText = (docx: Buffer): string =>
  new PizZip(docx).file('word/document.xml')?.asText().replace(/<[^>]+>/g, '') ?? '';

describe('Render de plantillas DOCX (PostgreSQL real)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await bootModules(StorageModule, DocumentTemplatesModule);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('reemplaza los placeholders de una plantilla real y produce un DOCX válido', async () => {
    const template = await readFile('templates/acts/acta-entrega-prestamo.docx');
    const output = renderDocx(template, {
      'acta.numero': 'OCI-01-65-2026-0001',
      'acta.fecha': '2026-09-25',
      'origen.codigo': '4100',
      'origen.nombre': 'Control Interno',
      'destino.codigo': '1010',
      'destino.nombre': 'Rectoría',
      'solicitante.nombre': 'Ana Ruiz',
      'receptor.nombre': 'Luis Pérez',
      'prestamo.justificacion': 'Evento institucional',
    });

    const zip = new PizZip(output);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    const text = documentText(output);
    expect(text).toContain('OCI-01-65-2026-0001');
    expect(text).toContain('4100 — Control Interno');
    expect(text).toContain('Receptor: Luis Pérez');
    expect(text).not.toContain('{{');
    expect(text).not.toContain('undefined');
  });

  it('generar sin plantilla activa es un error explícito, no un null silencioso', async () => {
    const service = moduleRef.get(DocumentTemplatesService);
    const actor = await createActor(moduleRef.get(DataSource));
    await expect(
      service.generate({
        documentType: 'WRITE_OFF_ACT',
        entityType: 'ASSET',
        entityId: actor.id,
        context: {},
        actorId: actor.id,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_ACTIVE' });
  });
});
