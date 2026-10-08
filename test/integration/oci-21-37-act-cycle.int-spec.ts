import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import type { StorageDriver } from '../../src/config/configuration.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';
import { formatMoney } from '../../src/modules/inventories/domain/inventory-act.js';
import {
  addDays,
  bogotaDate,
} from '../../src/modules/inventories/domain/inventory-schedule.js';
import { SAMPLE } from '../../scripts/formats/build-oci-21-37-template.mjs';
import { findLeftovers } from '../../scripts/formats/template-leftovers.mjs';
import { openTestSession, scalar, useSharedStorage } from './helpers.js';
import { pdfText, sampleLeftovers, squash } from './pdf-text.js';

const ACT_FORMAT = 'OCI-21-37';
const TEMPLATE = 'templates/formats/OCI-21-37-v2.docx';
const GOTENBERG = process.env['GOTENBERG_URL'];
const OUTPUT = process.env['OCI_21_37_OUTPUT_DIR'];
/** Montos como quedan en la capa de texto del PDF (el espacio duro del formato es-CO se vuelve espacio). */
const money = (value: number) => squash(formatMoney(value));
// Fecha de vigencia del formato según el Excel (celda I6, «Fecha: 2026-09-08»).
const EFFECTIVE_DATE = '2026-09-08';

interface Who {
  readonly personId: string;
  readonly userId: string;
  readonly token: string;
  readonly actor: AuthenticatedUser;
}

/**
 * Acta OCI-21-37 de punta a punta contra PostgreSQL real y Gotenberg: la plantilla construida desde el Excel se carga
 * como versión vigente (solo en esta prueba), una toma de un centro se programa, se verifica, se categoriza, se cierra
 * y se concilia con doble firma; el motor genera el DOCX y lo convierte a PDF. Con OCI_21_37_OUTPUT_DIR deja el PDF,
 * el DOCX y la capa de texto para que alguien los abra.
 */
describe
  .runIf(Boolean(GOTENBERG))
  .sequential(
    'Acta de toma física OCI-21-37 con la plantilla institucional (PostgreSQL + Gotenberg)',
    () => {
      let app: NestExpressApplication;
      let dataSource: DataSource;
      let engine: DocumentEngineService;
      let director: Who;
      let approver: Who;
      let base: { categoryId: string; acquisitionTypeId: string; room: string };
      let templateId = '';
      let sequenceBefore: string | undefined;
      const today = bogotaDate(new Date());

      const http = () => request(app.getHttpServer());
      const as = (who: Who) => ({ Authorization: `Bearer ${who.token}` });
      const binary = (path: string, who: Who) =>
        http()
          .get(path)
          .set(as(who))
          .buffer(true)
          .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => done(null, Buffer.concat(chunks)));
          });

      const person = async (
        first: string,
        last: string,
        position: string,
        role: string | null,
        mfa = false,
      ): Promise<Who> => {
        const tag = randomUUID().slice(0, 8);
        const personId = await scalar<string>(
          dataSource,
          `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, $2, $3, 'CC', $4, $5) RETURNING id`,
          [
            first,
            last,
            `${first.toLowerCase().replace(/\s/g, '.')}.${tag}@unac.edu.co`,
            `7${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 100)}`,
            position,
          ],
        );
        const userId = await scalar<string>(
          dataSource,
          `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
          [personId, `oci2137.${tag}`, mfa],
        );
        if (role) {
          await dataSource.query(
            `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
            [userId, role],
          );
        }
        const sessionId = await openTestSession(dataSource, userId, {
          mfaVerified: mfa,
        });
        const actor: AuthenticatedUser = {
          id: userId,
          personId,
          username: `oci2137.${tag}`,
          roles: role ? [role] : [],
          scopes: [],
          mustChangePassword: false,
        };
        return {
          personId,
          userId,
          token: app.get(TokenService).signAccessToken({ ...actor, sessionId }),
          actor,
        };
      };

      /** Jefatura vigente del centro: firma el acta como ENCARGADO. */
      const headOf = (costCenterId: string, who: Who) =>
        dataSource.query(
          `INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba')`,
          [who.personId, costCenterId],
        );

      const center = (name: string) =>
        scalar<string>(
          dataSource,
          `INSERT INTO cost_center (external_code, name) VALUES ($1, $2) RETURNING id`,
          [`7${Math.floor(Math.random() * 9000 + 1000)}`, name],
        );

      const newAsset = async (
        costCenterId: string,
        description: string,
        price: number,
      ) =>
        (
          await app.get(AssetsService).create(
            {
              categoryId: base.categoryId,
              costCenterId,
              acquisitionTypeId: base.acquisitionTypeId,
              description,
              acquisitionDate: '2021-03-15',
              acquisitionPrice: price,
              locationId: base.room,
            },
            director.actor,
          )
        ).id;

      const depreciation = (assetId: string, bookValue: number) =>
        dataSource.query(
          `INSERT INTO asset_depreciation (asset_id, period_year, period_month, method, monthly_depreciation, accumulated_depreciation, book_value)
       VALUES ($1, 2025, 12, 'STRAIGHT_LINE', 10, 100, $2)`,
          [assetId, bookValue],
        );

      const post = (
        who: Who,
        path: string,
        body: Record<string, unknown> = {},
      ) => http().post(`/api/v1/inventories${path}`).set(as(who)).send(body);

      const detail = async (id: string) =>
        (
          await http()
            .get(`/api/v1/inventories/${id}`)
            .set(as(director))
            .expect(200)
        ).body.data as {
          items: Array<{ id: string; assetId: string | null }>;
          act: Record<string, unknown>;
        };

      /** Programa, inicia, verifica, categoriza y cierra una toma del centro; devuelve su id. */
      const executed = async (
        costCenterId: string,
        responsible: Who,
        plan: ReadonlyArray<{
          assetId: string;
          action: 'FOUND' | 'MISSING' | 'SKIP';
          condition?: string;
          category?: string;
          notes?: string;
        }>,
        attendedByName?: string,
      ) => {
        const created = await http()
          .post('/api/v1/inventories')
          .set(as(director))
          .send({
            name: 'Toma anual del centro',
            scope: 'COST_CENTER',
            scopeId: costCenterId,
            plannedStartDate: today,
            plannedEndDate: addDays(today, 2),
            responsibleUserId: responsible.userId,
            reminderOffsetsDays: [],
          });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.data.id as string;
        expect((await post(responsible, `/${id}/start`)).status).toBe(200);
        const view = await detail(id);
        for (const step of plan) {
          if (step.action === 'FOUND') {
            const verified = await post(responsible, `/${id}/verify-asset`, {
              assetId: step.assetId,
              condition: step.condition ?? 'GOOD',
              notes: step.notes,
            });
            expect(verified.status, JSON.stringify(verified.body)).toBe(200);
          } else if (step.action === 'MISSING') {
            const missing = await post(responsible, `/${id}/report-not-found`, {
              assetId: step.assetId,
              otherCause: 'No se ubicó en la oficina ni en la bodega',
            });
            expect(missing.status, JSON.stringify(missing.body)).toBe(200);
          }
          if (step.category) {
            const itemId = view.items.find(
              (item) => item.assetId === step.assetId,
            )?.id;
            const set = await http()
              .put(`/api/v1/inventories/${id}/items/${itemId}/finding-category`)
              .set(as(responsible))
              .send({ code: step.category });
            expect(set.status, JSON.stringify(set.body)).toBe(200);
          }
        }
        expect(
          (
            await post(responsible, `/${id}/report-unexpected`, {
              notes: 'Archivador metálico sin placa',
              locationId: base.room,
              condition: 'FAIR',
            })
          ).status,
        ).toBe(200);
        const closed = await post(responsible, `/${id}/close`, {
          allowUnverified: true,
          ...(attendedByName ? { attendedByName } : {}),
        });
        expect(closed.status, JSON.stringify(closed.body)).toBe(200);
        return id;
      };

      /** Genera el acta encolada y deja PDF, DOCX y texto; devuelve el texto del PDF y del DOCX. */
      const generated = async (id: string, name: string) => {
        await engine.processPending(1000);
        const view = await detail(id);
        expect(view.act, JSON.stringify(view.act)).toMatchObject({
          generation: 'GENERATED',
          reason: null,
          status: 'PENDING_SIGNATURE',
        });
        const documentId = view.act['documentId'] as string;
        const pdf = await binary(
          `/api/v1/documents/${documentId}/pdf`,
          director,
        );
        const docx = await binary(
          `/api/v1/documents/${documentId}/docx`,
          director,
        );
        expect(pdf.status).toBe(200);
        expect(docx.status).toBe(200);
        const pdfBody = pdf.body as Buffer;
        const docxBody = docx.body as Buffer;
        const text = await pdfText(pdfBody);
        const pages = (await PDFDocument.load(pdfBody)).getPageCount();
        if (OUTPUT) {
          mkdirSync(OUTPUT, { recursive: true });
          writeFileSync(join(OUTPUT, `${name}.pdf`), pdfBody);
          writeFileSync(join(OUTPUT, `${name}.docx`), docxBody);
          writeFileSync(join(OUTPUT, `${name}.txt`), text);
        }
        return {
          text: squash(text),
          pages,
          number: view.act['number'] as string,
          docx: docxBody,
          documentId,
        };
      };

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        app = moduleRef.createNestApplication<NestExpressApplication>();
        app.setGlobalPrefix('api/v1');
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();
        for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
          await job.stop();
        }
        dataSource = app.get(DataSource);
        engine = app.get(DocumentEngineService);
        await useSharedStorage(dataSource);
        sequenceBefore = await scalar<string | undefined>(
          dataSource,
          `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
          [ACT_FORMAT],
        );
        const campus = await scalar<string>(
          dataSource,
          `INSERT INTO campus (code, name) VALUES ('IT-TF', 'Sede toma física') RETURNING id`,
        );
        const building = await scalar<string>(
          dataSource,
          `INSERT INTO building (campus_id, code, name) VALUES ($1, 'IT-TFB', 'Bloque administrativo') RETURNING id`,
          [campus],
        );
        base = {
          categoryId: await scalar<string>(
            dataSource,
            `INSERT INTO asset_category (code, name, requires_photo) VALUES ('IT_TF2137', 'Mobiliario y equipo', FALSE) RETURNING id`,
          ),
          acquisitionTypeId: await scalar<string>(
            dataSource,
            `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`,
          ),
          room: await scalar<string>(
            dataSource,
            `INSERT INTO location (building_id, code, name, location_type) VALUES ($1, 'IT-TF201', 'Oficina 201', 'OFFICE') RETURNING id`,
            [building],
          ),
        };
        director = await person(
          'Directora',
          'Pruebas Acta',
          'Directora de Control Interno',
          'INTERNAL_CONTROL_DIRECTOR',
        );
        approver = await person(
          'Laura Milena',
          'Quintero Ruiz',
          'Jefe de Control Interno',
          'INTERNAL_CONTROL_DIRECTOR',
          true,
        );
        // Solo en esta prueba: la plantilla construida desde el Excel queda como versión vigente del formato.
        const uploaded = await engine.uploadTemplate(
          ACT_FORMAT,
          { buffer: readFileSync(TEMPLATE), originalname: 'OCI-21-37-v2.docx' },
          { sgcVersion: '2', effectiveDate: EFFECTIVE_DATE },
          director.userId,
        );
        templateId = uploaded.id ?? '';
      });

      afterAll(async () => {
        // Deja la BD compartida como estaba: OCI-21-37 sin plantilla, sin actas ni solicitudes de tomas, y su consecutivo.
        await dataSource.query(
          'UPDATE physical_inventory_act SET document_request_id = NULL, document_id = NULL',
        );
        const ids = (
          (await dataSource.query(
            `SELECT id FROM document WHERE entity_type = 'PHYSICAL_INVENTORY_ACT'`,
          )) as Array<{ id: string }>
        ).map((row) => row.id);
        await dataSource.query(
          'DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)',
          [ids],
        );
        await dataSource.query(
          'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
          [ids],
        );
        await dataSource.query(
          'DELETE FROM signature_signing_link WHERE document_id = ANY($1)',
          [ids],
        );
        await dataSource.query(
          'DELETE FROM signature_envelope WHERE document_id = ANY($1)',
          [ids],
        );
        await dataSource.query(
          `DELETE FROM document_request WHERE payload->>'entityType' = 'PHYSICAL_INVENTORY_ACT'`,
        );
        await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [
          ids,
        ]);
        await dataSource.query(
          'DELETE FROM document_template_version WHERE id = $1',
          [templateId || null],
        );
        await dataSource.query(
          `DELETE FROM document_sequence WHERE format_key = $1`,
          [ACT_FORMAT],
        );
        if (sequenceBefore !== undefined) {
          await dataSource.query(
            `INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`,
            [ACT_FORMAT, sequenceBefore],
          );
        }
        await dataSource.query(
          `DELETE FROM asset_depreciation WHERE asset_id IN (SELECT id FROM asset WHERE category_id = $1)`,
          [base.categoryId],
        );
        await app.close();
      });

      it('toma de un centro → verificar → categorizar → cerrar → conciliar con doble firma → el motor genera el PDF con la plantilla', async () => {
        const centerId = await center('DECANATURA DE CIENCIAS ADMINISTRATIVAS');
        const code = await scalar<string>(
          dataSource,
          'SELECT external_code FROM cost_center WHERE id = $1',
          [centerId],
        );
        const desk = await newAsset(
          centerId,
          'ESCRITORIO EN L CON CAJONERA',
          1_250_000,
        );
        const laptop = await newAsset(
          centerId,
          'PORTATIL LENOVO THINKPAD E14 CORE I7 16GB',
          4_180_000,
        );
        const chair = await newAsset(
          centerId,
          'SILLA ERGONOMICA CON BRAZOS',
          690_000,
        );
        const projector = await newAsset(
          centerId,
          'VIDEOPROYECTOR VIEWSONIC PA503',
          1_980_000,
        );
        const phone = await newAsset(
          centerId,
          'TELEFONO IP YEALINK T31P',
          245_000,
        );
        await depreciation(desk, 830_000);
        await depreciation(laptop, 2_090_000);
        await depreciation(chair, 120_000);
        // Proyector y teléfono sin depreciación: su valor en libros no existe y el acta debe decir «Sin dato».
        // Firma como ENCARGADO la jefa vigente del centro, no el responsable de la toma.
        const head = await person('Gloria Patricia', 'Rendón Mejía', 'Decana', null);
        await headOf(centerId, head);
        const responsible = await person(
          'Andrés Felipe',
          'Gómez Tobón',
          'Profesional de Control Interno',
          'INTERNAL_CONTROL_DIRECTOR',
        );
        const id = await executed(centerId, responsible, [
          { assetId: desk, action: 'FOUND', category: 'AU' },
          {
            assetId: laptop,
            action: 'FOUND',
            category: 'AU',
            notes: 'Asignado al decano',
          },
          {
            assetId: chair,
            action: 'FOUND',
            condition: 'POOR',
            category: 'AOD',
            notes: 'Espaldar roto',
          },
          { assetId: projector, action: 'MISSING', category: 'ANE' },
          { assetId: phone, action: 'SKIP' },
        ], 'Asistente de la decanatura');
        // Doble firma de la conciliación: la pide el responsable y la aprueba otra persona (INVENTORY_RECONCILE_SOD).
        expect((await post(responsible, `/${id}/reconcile`)).status).toBe(200);
        const approved = await post(approver, `/${id}/reconcile/approve`);
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.data).toMatchObject({
          status: 'RECONCILED',
          act: { generation: 'PENDING' },
        });

        const { text, pages, number, docx, documentId } = await generated(
          id,
          'acta-oci-21-37',
        );
        const tomaCode = await scalar<string>(
          dataSource,
          'SELECT code FROM physical_inventory WHERE id = $1',
          [id],
        );
        expect(findLeftovers(docx, SAMPLE, { metadata: true })).toEqual([]);
        expect(sampleLeftovers(text, SAMPLE, { numbers: true })).toEqual([]);
        expect(pages).toBe(2);
        for (const fragment of [
          'Código: OCI-21-37',
          'Versión: 2',
          'ACTA DE TOMA FISICA DE INVENTARIO DE ACTIVOS FIJOS',
          `Informe de Hallazgos No. ${number}`,
          `Centro de Costos ${code} DECANATURA DE CIENCIAS ADMINISTRATIVAS`,
          `Toma física ${tomaCode} — Toma anual del centro`,
          'Responsable Gloria Patricia Rendón Mejía',
          'Atendió por el área Asistente de la decanatura',
          // Porcentaje sobre el precio de compra (5 430 000 / 8 100 000), no sobre el número de bienes.
          `AU — Activos en uso 2 ${money(5_430_000)} 67,04 % ${money(2_920_000)}`,
          `ANE — Activos no encontrados 1 ${money(1_980_000)} 24,44 % Sin dato`,
          `AOD — Activos obsoletos dañados 1 ${money(690_000)} 8,52 % ${money(120_000)}`,
          'Porcentaje calculado sobre el precio de compra',
          'El valor en libros es otro dato y no entra en el porcentaje',
          `Total 4 ${money(8_100_000)} 100,00 % Sin dato`,
          'Laura Milena Quintero Ruiz',
          'PORTATIL LENOVO THINKPAD E14 CORE I7 16GB',
          'No se ubicó en la oficina ni en la bodega',
          'Archivador metálico sin placa',
          'FECHA: 2026-09-08',
        ]) {
          expect(text, fragment).toContain(fragment);
        }
        // ANI está inactiva y pendiente de definición en el catálogo: no aparece como fila.
        expect(text).not.toMatch(/\bANI\b/);
        expect(text).not.toContain('Sustitución de firmante');

        // Lo que ven los firmantes: el PDF del sobre, con la hoja de firmas al final.
        const [envelope] = (await dataSource.query(
          'SELECT current_pdf_driver, current_pdf_key FROM signature_envelope WHERE document_id = $1',
          [documentId],
        )) as Array<{
          current_pdf_driver: StorageDriver;
          current_pdf_key: string;
        }>;
        const forSigning = await app
          .get(StorageService)
          .getFrom(
            envelope?.current_pdf_driver ?? 'project',
            envelope?.current_pdf_key ?? '',
          );
        const sheet = squash(await pdfText(forSigning));
        expect(sheet).toContain('Hoja de firmas');
        expect(sheet).toContain('1. Responsable');
        expect(sheet).toContain('2. Control Interno');
        // Firman en el orden del formato: primero el responsable, luego Control Interno (sesión con MFA).
        const rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
        const early = await http()
          .post(`/api/v1/documents/${documentId}/signatures/2`)
          .set(as(approver))
          .send({ rubric });
        expect(early.status).not.toBe(200);
        for (const [order, who] of [
          [1, head],
          [2, approver],
        ] as const) {
          const signed = await http()
            .post(`/api/v1/documents/${documentId}/signatures/${order}`)
            .set(as(who))
            .set('X-Forwarded-For', '203.0.113.70')
            .send({ rubric });
          expect(signed.status, JSON.stringify(signed.body)).toBe(200);
        }
        const final = await binary(
          `/api/v1/documents/${documentId}/pdf`,
          director,
        );
        const finalText = squash(await pdfText(final.body as Buffer));
        if (OUTPUT) {
          writeFileSync(
            join(OUTPUT, 'acta-oci-21-37-para-firma.pdf'),
            forSigning,
          );
          writeFileSync(
            join(OUTPUT, 'acta-oci-21-37-firmada.pdf'),
            final.body as Buffer,
          );
          writeFileSync(join(OUTPUT, 'acta-oci-21-37-firmada.txt'), finalText);
        }
        expect(finalText).toContain('Hoja de firmas');
        expect(finalText).toContain('Gloria Patricia Rendón Mejía');
        expect(sampleLeftovers(finalText, SAMPLE, { numbers: true })).toEqual(
          [],
        );
      });

      it('separación de funciones: si el jefe que firma como ENCARGADO aprueba, el acta lleva la sustitución de Control Interno con su motivo', async () => {
        const centerId = await center('OFICINA DE ADMISIONES');
        const cabinet = await newAsset(
          centerId,
          'ARCHIVADOR RODANTE 4 GAVETAS',
          870_000,
        );
        await depreciation(cabinet, 410_000);
        // El aprobador es a la vez el jefe del centro de la toma: firmaría RESPONSABLE (ENCARGADO) y AUDITA.
        await headOf(centerId, approver);
        const responsible = await person(
          'Mateo',
          'Arango Vélez',
          'Profesional de Control Interno',
          'INTERNAL_CONTROL_DIRECTOR',
        );
        const id = await executed(centerId, responsible, [
          { assetId: cabinet, action: 'FOUND', category: 'AU' },
        ]);
        expect((await post(responsible, `/${id}/reconcile`)).status).toBe(200);
        const approved = await post(approver, `/${id}/reconcile/approve`);
        expect(approved.body.data.act).toMatchObject({
          generation: 'NOT_ENQUEUED',
          reason: 'ENQUEUE_FAILED',
        });
        const enqueued = await post(director, `/${id}/act/enqueue`, {
          signerSubstitutions: {
            AUDITA: {
              personId: director.personId,
              reason: 'La jefa del centro aprobó la conciliación',
            },
          },
        });
        expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);

        const { text } = await generated(id, 'acta-oci-21-37-sustitucion');
        expect(sampleLeftovers(text, SAMPLE, { numbers: true })).toEqual([]);
        expect(text).toContain(
          'Sustitución de firmante (separación de funciones): firma por Control Interno Directora Pruebas Acta en lugar de Laura Milena Quintero Ruiz, que firma el acta como Responsable. Motivo: La jefa del centro aprobó la conciliación',
        );
      });

      it('toma por ubicación con activos de tres centros: un PDF por centro con su consecutivo, sus activos y su jefe; el centro sin jefe queda sin acta', async () => {
        const lab = await scalar<string>(
          dataSource,
          `INSERT INTO location (building_id, code, name, location_type)
           SELECT building_id, 'IT-TF-LAB', 'Laboratorio de sistemas', 'OFFICE' FROM location WHERE id = $1 RETURNING id`,
          [base.room],
        );
        const faculty = await center('FACULTAD DE INGENIERIA');
        const systems = await center('DEPARTAMENTO DE SISTEMAS');
        const maintenance = await center('MANTENIMIENTO');
        const codeOf = (id: string) =>
          scalar<string>(dataSource, 'SELECT external_code FROM cost_center WHERE id = $1', [id]);
        const inLab = async (costCenterId: string, description: string, price: number) => {
          const id = await newAsset(costCenterId, description, price);
          await dataSource.query('UPDATE asset SET current_location_id = $2 WHERE id = $1', [id, lab]);
          return id;
        };
        const oscilloscope = await inLab(faculty, 'OSCILOSCOPIO DIGITAL TEKTRONIX', 3_200_000);
        const server = await inLab(systems, 'SERVIDOR DELL POWEREDGE R250', 9_800_000);
        const drill = await inLab(maintenance, 'TALADRO PERCUTOR DEWALT', 540_000);
        const dean = await person('Carlos Alberto', 'Restrepo Díaz', 'Decano', null);
        await headOf(faculty, dean);
        const systemsHead = await person('Diana Marcela', 'Ospina Loaiza', 'Jefa de Sistemas', null);
        await headOf(systems, systemsHead);
        const responsible = await person('Sara', 'Montoya Ríos', 'Profesional de Control Interno', 'INTERNAL_CONTROL_DIRECTOR');

        const created = await http()
          .post('/api/v1/inventories')
          .set(as(director))
          .send({
            name: 'Toma del laboratorio compartido',
            scope: 'LOCATION',
            scopeId: lab,
            plannedStartDate: today,
            plannedEndDate: addDays(today, 2),
            responsibleUserId: responsible.userId,
            reminderOffsetsDays: [],
          });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.data.id as string;
        expect((await post(responsible, `/${id}/start`)).status).toBe(200);
        const view = await detail(id);
        for (const assetId of [oscilloscope, server, drill]) {
          expect((await post(responsible, `/${id}/verify-asset`, { assetId, condition: 'GOOD' })).status).toBe(200);
          const itemId = view.items.find((item) => item.assetId === assetId)?.id;
          const set = await http()
            .put(`/api/v1/inventories/${id}/items/${itemId}/finding-category`)
            .set(as(responsible))
            .send({ code: 'AU' });
          expect(set.status, JSON.stringify(set.body)).toBe(200);
        }
        expect(
          (await post(responsible, `/${id}/report-unexpected`, { notes: 'Fuente de poder sin placa', locationId: lab, condition: 'GOOD' }))
            .status,
        ).toBe(200);
        const closed = await post(responsible, `/${id}/close`, {
          allowUnverified: true,
          attendedBy: [
            { costCenterId: faculty, name: 'Laboratorista de la facultad' },
            { costCenterId: systems, name: 'Técnico de soporte' },
          ],
        });
        expect(closed.status, JSON.stringify(closed.body)).toBe(200);
        expect(closed.body.data.acts).toHaveLength(3);
        // El sobrante sin placa no es de ningún centro: bloquea la conciliación hasta elegir el suyo (la facultad).
        const blocked = await post(responsible, `/${id}/reconcile`);
        expect([blocked.status, blocked.body.error.code]).toEqual([409, 'INVENTORY_UNASSIGNED_SURPLUS']);
        const surplusId = ((await detail(id)).items as unknown as Array<{ id: string; notes: string | null }>).find(
          (item) => item.notes === 'Fuente de poder sin placa',
        )?.id;
        const assigned = await http()
          .put(`/api/v1/inventories/${id}/items/${surplusId}/surplus-center`)
          .set(as(responsible))
          .send({ costCenterId: faculty });
        expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
        expect((await post(responsible, `/${id}/reconcile`)).status).toBe(200);
        const approved = await post(approver, `/${id}/reconcile/approve`);
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        await engine.processPending(1000);
        const acts = new Map(
          ((await detail(id)) as unknown as { acts: Array<Record<string, unknown> & { costCenter: { id: string } }> }).acts.map(
            (act) => [act.costCenter.id, act],
          ),
        );
        expect(acts.get(maintenance)).toMatchObject({ generation: 'NOT_ENQUEUED', reason: 'NO_COST_CENTER_HEAD' });
        const pdfOf = async (centerId: string, name: string) => {
          const act = acts.get(centerId) as Record<string, unknown>;
          expect(act, JSON.stringify(act)).toMatchObject({ generation: 'GENERATED', status: 'PENDING_SIGNATURE' });
          const pdf = await binary(`/api/v1/documents/${act['documentId'] as string}/pdf`, director);
          expect(pdf.status).toBe(200);
          const text = await pdfText(pdf.body as Buffer);
          if (OUTPUT) {
            mkdirSync(OUTPUT, { recursive: true });
            writeFileSync(join(OUTPUT, `${name}.pdf`), pdf.body as Buffer);
            writeFileSync(join(OUTPUT, `${name}.txt`), text);
          }
          return { text: squash(text), number: act['number'] as string };
        };
        const facultyPdf = await pdfOf(faculty, 'acta-oci-21-37-ubicacion-facultad');
        const systemsPdf = await pdfOf(systems, 'acta-oci-21-37-ubicacion-sistemas');
        expect(facultyPdf.number).not.toBe(systemsPdf.number);
        for (const fragment of [
          `Informe de Hallazgos No. ${facultyPdf.number}`,
          `Centro de Costos ${await codeOf(faculty)} FACULTAD DE INGENIERIA`,
          'Responsable Carlos Alberto Restrepo Díaz',
          'Atendió por el área Laboratorista de la facultad',
          'OSCILOSCOPIO DIGITAL TEKTRONIX',
          `AU — Activos en uso 1 ${money(3_200_000)} 100,00 %`,
          'Fuente de poder sin placa',
        ]) {
          expect(facultyPdf.text, fragment).toContain(fragment);
        }
        expect(systemsPdf.text).not.toContain('Fuente de poder sin placa');
        expect(facultyPdf.text).not.toContain('SERVIDOR DELL POWEREDGE R250');
        expect(facultyPdf.text).not.toContain('TALADRO PERCUTOR DEWALT');
        for (const fragment of [
          `Informe de Hallazgos No. ${systemsPdf.number}`,
          `Centro de Costos ${await codeOf(systems)} DEPARTAMENTO DE SISTEMAS`,
          'Responsable Diana Marcela Ospina Loaiza',
          'Atendió por el área Técnico de soporte',
          'SERVIDOR DELL POWEREDGE R250',
          `AU — Activos en uso 1 ${money(9_800_000)} 100,00 %`,
        ]) {
          expect(systemsPdf.text, fragment).toContain(fragment);
        }
        expect(systemsPdf.text).not.toContain('OSCILOSCOPIO DIGITAL TEKTRONIX');
        expect(sampleLeftovers(facultyPdf.text, SAMPLE, { numbers: true })).toEqual([]);
        expect(sampleLeftovers(systemsPdf.text, SAMPLE, { numbers: true })).toEqual([]);
      });
    },
  );
